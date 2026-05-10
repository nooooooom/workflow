/**
 * Memory Agent — Background Memory Management
 *
 * Runs as a background process to manage workflow memory:
 * - Auto-generates summaries when steps complete
 * - Maintains artifact index
 * - Cleans up expired history
 * - Updates step metadata
 *
 * Commands:
 *   start      --dir <path> [--run <run-id>]           Start memory agent for workflow
 *   summarize  --dir <path> --run <run-id> --step <id> Generate summary for step
 *   index      --dir <path> [--run <run-id>]           Rebuild artifact index
 *   cleanup    --dir <path> [--max-days <n>]           Clean up old history entries
 *   status     --dir <path> [--run <run-id>]           Show memory statistics
 *
 * Usage:
 *   node engine/memory-agent.mjs start --dir ".workflows/my-workflow" --run "run-xxx"
 */

import {
  readJSON, writeJSON, workflowPath, getWorkflowRoot,
  now, parseArgs, output, fail,
  migrateToV3, listRuns, getStatePath, getHistoryPath, getSummaryCachePath,
  ensureMemoryDir, detectSchema, resolveArtifact,
} from './utils.mjs';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join, dirname, basename, extname } from 'node:path';

// ── Constants ─────────────────────────────────────────────

const MAX_HISTORY_DAYS = 30;       // Default: keep 30 days of history
const MAX_HISTORY_EVENTS = 100;    // Max events to keep per workflow
const SUMMARY_MIN_LENGTH = 50;     // Minimum chars for valid summary

// ── Helpers ───────────────────────────────────────────────

function loadWorkflow(dir) {
  if (!dir) fail('Workflow directory is required');
  const workflowFilePath = workflowPath(dir);
  const wf = readJSON(workflowFilePath);
  if (!wf) fail(`No workflow found at ${dir}`);
  return wf;
}

function loadState(dir, runId) {
  if (!runId) fail('--run is required');
  const state = readJSON(getStatePath(dir, runId));
  if (!state) fail(`Run "${runId}" not found`);
  return state;
}

function saveState(dir, runId, state) {
  state.updated_at = now();
  writeJSON(getStatePath(dir, runId), state);
}

/**
 * Resolve run ID - auto-select if single run, prompt if multiple
 */
async function resolveRunId(dir, runId) {
  if (runId) return runId;

  const runs = listRuns(dir);
  if (runs.length === 0) {
    fail('No runs found. Start a run with: node engine/session.mjs run --dir <path>');
  }
  if (runs.length === 1) {
    return runs[0].id;
  }

  // Multiple runs - user must specify
  fail(`Multiple runs found. Please specify --run. Available: ${runs.map(r => r.id).join(', ')}`);
}

function saveWorkflow(dir, wf) {
  writeJSON(workflowPath(dir), wf);
}

function getStep(wf, stepId) {
  const id = Number(stepId);
  const step = wf.steps.find(s => s.id === id);
  if (!step) fail(`Step ${stepId} not found`);
  return step;
}

function getArtifactContent(dir, runId, artifactOrStep) {
  // Support both old call signature (path string) and new (step object)
  let artifactPath;
  if (typeof artifactOrStep === 'string') {
    artifactPath = artifactOrStep;
  } else if (artifactOrStep && typeof artifactOrStep === 'object') {
    const resolved = resolveArtifact(artifactOrStep.artifact, artifactOrStep.id);
    artifactPath = resolved.path;
  } else {
    return null;
  }
  const wfRoot = getWorkflowRoot(dir);
  // v3: artifacts stored in runs/{run-id}/artifacts/
  // v1/v2: artifacts stored in artifacts/
  const v3Path = join(wfRoot, 'runs', runId, artifactPath);
  const v1Path = join(wfRoot, artifactPath);

  if (existsSync(v3Path)) {
    return readFileSync(v3Path, 'utf-8');
  }
  if (existsSync(v1Path)) {
    return readFileSync(v1Path, 'utf-8');
  }
  return null;
}

function loadSummaryCache(dir) {
  const cachePath = getSummaryCachePath(dir);
  return readJSON(cachePath) || {};
}

function saveSummaryCache(dir, cache) {
  writeJSON(getSummaryCachePath(dir), cache);
}

// ── Start Command ─────────────────────────────────────────

/**
 * Start memory agent - performs initial setup and registers hooks.
 */
function start(flags) {
  const { dir } = flags;
  if (!dir) fail('--dir is required');

  let wf = loadWorkflow(dir);

  const memoryDir = ensureMemoryDir(dir);

  // Initialize memory state if not exists
  if (!wf.memory) {
    wf.memory = {
      initialized_at: now(),
      artifact_index: {},
      last_cleanup: null,
    };
  }

  // Build initial artifact index
  const artifactIndex = buildArtifactIndex(dir, wf);
  wf.memory.artifact_index = artifactIndex;

  saveWorkflow(dir, wf);

  // Create memory state file
  const memoryStatePath = join(memoryDir, 'state.json');
  writeFileSync(memoryStatePath, JSON.stringify({
    workflow_name: wf.name,
    started_at: now(),
    status: 'active',
    artifact_count: Object.keys(artifactIndex).length,
  }, null, 2));

  output({
    ok: true,
    message: 'Memory agent started',
    memory_dir: memoryDir,
    artifact_index: artifactIndex,
    initialized: wf.memory.initialized_at,
  });
}

// ── Summarize Command ─────────────────────────────────────

/**
 * Generate summary for a completed step.
 */
async function summarize(flags) {
  const { dir, step: stepId, run: runId } = flags;
  if (!dir) fail('--dir is required');
  if (!stepId) fail('--step is required');

  let wf = loadWorkflow(dir);


  // Resolve run ID
  const resolvedRunId = await resolveRunId(dir, runId);

  const step = getStep(wf, stepId);
  const runState = loadState(dir, resolvedRunId);
  const stepState = runState.step_states?.[stepId] || {};

  // Check step status
  if (!['completed', 'gate_pending'].includes(stepState.status)) {
    output({
      ok: false,
      warning: `Step ${stepId} is not completed (status: ${stepState.status})`,
      step: {
        id: stepId,
        name: step.name,
        status: stepState.status,
      },
    });
    return;
  }

  // Get artifact content
  const artifactContent = step.artifact
    ? getArtifactContent(dir, resolvedRunId, step)
    : null;

  if (!artifactContent) {
    output({
      ok: true,
      warning: 'No artifact content found',
      step: {
        id: stepId,
        name: step.name,
        summary: `Step "${step.name}" completed`,
        key_decisions: [],
        artifacts: [],
      },
    });
    return;
  }

  // Generate summary using context-manager logic
  const summaryResult = generateSummary(artifactContent, step);

  // Update state in runs/{run-id}/state.json
  stepState.summary = summaryResult.summary;
  stepState.key_decisions = summaryResult.key_decisions;
  stepState.summary_generated_at = now();
  runState.step_states[stepId] = stepState;
  saveState(dir, resolvedRunId, runState);

  // Update memory cache (stored in memory/summary-cache.json)
  const summaryCache = loadSummaryCache(dir);
  summaryCache[stepId] = {
    summary: summaryResult.summary,
    key_decisions: summaryResult.key_decisions,
    generated_at: now(),
    artifact_hash: hashContent(artifactContent),
  };
  saveSummaryCache(dir, summaryCache);

  // Write summary file
  const memoryDir = ensureMemoryDir(dir);
  const summaryPath = join(memoryDir, `step-${stepId}-summary.json`);
  writeFileSync(summaryPath, JSON.stringify({
    step_id: stepId,
    step_name: step.name,
    summary: summaryResult.summary,
    key_decisions: summaryResult.key_decisions,
    artifacts: summaryResult.artifacts,
    generated_at: now(),
  }, null, 2));

  output({
    ok: true,
    message: `Summary generated for step ${stepId}`,
    step: {
      id: stepId,
      name: step.name,
      summary: summaryResult.summary,
      key_decisions: summaryResult.key_decisions,
      artifacts: summaryResult.artifacts,
    },
  });
}

/**
 * Generate summary from content.
 */
function generateSummary(content, step) {
  const lines = content.split('\n').filter(l => l.trim());
  
  // Extract summary text
  const contentLines = lines.filter(l => 
    !l.startsWith('#') && 
    !l.startsWith('---') && 
    l.trim().length > 20
  );
  
  let summary = 'No summary available';
  if (contentLines.length > 0) {
    summary = contentLines.slice(0, 3).join(' ').trim();
    if (summary.length > 500) {
      summary = summary.slice(0, 497) + '...';
    }
  }

  // Extract key decisions
  const keyDecisions = extractKeyDecisions(content);
  
  // List artifacts
  const artifacts = step.artifact ? [step.artifact] : [];

  return {
    summary,
    key_decisions: keyDecisions,
    artifacts,
  };
}

/**
 * Extract key decisions from content.
 */
function extractKeyDecisions(content) {
  const decisions = [];
  
  // Decision patterns
  const patterns = [
    /决定[：:]\s*(.+)/g,
    /决策[：:]\s*(.+)/g,
    /选择[：:]\s*(.+)/g,
    /Decision[：:]\s*(.+)/gi,
    /Chose[：:]\s*(.+)/gi,
    /结论[：:]\s*(.+)/g,
    /Conclusion[：:]\s*(.+)/gi,
  ];
  
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content)) !== null && decisions.length < 5) {
      decisions.push(match[1].trim().slice(0, 100));
    }
  }
  
  // Checkbox items
  const checkboxPattern = /- \[x\]\s*(.+)/g;
  let match;
  while ((match = checkboxPattern.exec(content)) !== null && decisions.length < 5) {
    decisions.push(match[1].trim().slice(0, 100));
  }
  
  return decisions;
}

/**
 * Simple hash function for content.
 */
function hashContent(content) {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16);
}

// ── Index Command ─────────────────────────────────────────

/**
 * Build/rebuild artifact index.
 */
function index(flags) {
  const { dir } = flags;
  if (!dir) fail('--dir is required');

  let wf = loadWorkflow(dir);


  const artifactIndex = buildArtifactIndex(dir, wf);

  if (!wf.memory) wf.memory = {};
  wf.memory.artifact_index = artifactIndex;
  wf.memory.index_updated_at = now();

  saveWorkflow(dir, wf);

  output({
    ok: true,
    message: 'Artifact index rebuilt',
    artifacts: artifactIndex,
    total_count: Object.keys(artifactIndex).length,
  });
}

/**
 * Build artifact index by scanning all run directories.
 */
function buildArtifactIndex(dir, wf) {
  const wfRoot = getWorkflowRoot(dir);
  const runsDir = join(wfRoot, 'runs');
  const index = {};

  // Scan all runs
  if (existsSync(runsDir)) {
    const runDirs = readdirSync(runsDir).filter(f => {
      const fullPath = join(runsDir, f);
      return statSync(fullPath).isDirectory();
    });

    for (const runDir of runDirs) {
      const artifactsDir = join(runsDir, runDir, 'artifacts');
      if (existsSync(artifactsDir)) {
        const files = readdirSync(artifactsDir);
        for (const file of files) {
          const fullPath = join(artifactsDir, file);
          if (statSync(fullPath).isFile()) {
            const stat = statSync(fullPath);
            const stepMatch = file.match(/^(\d+)-/);

            index[`runs/${runDir}/artifacts/${file}`] = {
              path: `runs/${runDir}/artifacts/${file}`,
              run_id: runDir,
              filename: file,
              step_id: stepMatch ? parseInt(stepMatch[1]) : null,
              size_bytes: stat.size,
              modified_at: stat.mtime.toISOString(),
              extension: extname(file),
            };
          }
        }
      }
    }
  }

  // Also scan legacy artifacts/ directory (v1/v2 compatibility)
  const legacyArtifactsDir = join(wfRoot, 'artifacts');
  if (existsSync(legacyArtifactsDir)) {
    const files = readdirSync(legacyArtifactsDir);
    for (const file of files) {
      const fullPath = join(legacyArtifactsDir, file);
      if (statSync(fullPath).isFile()) {
        const stat = statSync(fullPath);
        const stepMatch = file.match(/^(\d+)-/);

        index[`artifacts/${file}`] = {
          path: `artifacts/${file}`,
          run_id: null,
          filename: file,
          step_id: stepMatch ? parseInt(stepMatch[1]) : null,
          size_bytes: stat.size,
          modified_at: stat.mtime.toISOString(),
          extension: extname(file),
        };
      }
    }
  }

  return index;
}

// ── Cleanup Command ───────────────────────────────────────

/**
 * Clean up old history entries.
 */
async function cleanup(flags) {
  const { dir, maxDays, run: runId } = flags;
  if (!dir) fail('--dir is required');

  const wf = loadWorkflow(dir);
  const days = maxDays ? parseInt(maxDays) : MAX_HISTORY_DAYS;
  const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  // Resolve run ID
  const resolvedRunId = await resolveRunId(dir, runId);

  // Load history from runs/{run-id}/history.json
  const historyPath = getHistoryPath(dir, resolvedRunId);
  const history = readJSON(historyPath) || [];

  // Clean history
  const originalCount = history.length;
  const cleanedHistory = history.filter(event => {
    const eventDate = new Date(event.at);
    return eventDate >= cutoffDate;
  });

  // Keep important events regardless of age
  const importantEvents = ['workflow_created', 'workflow_completed', 'workflow_failed'];
  const importantHistory = history.filter(event =>
    importantEvents.includes(event.event)
  );

  // Merge and deduplicate
  const finalHistory = [...cleanedHistory];
  for (const event of importantHistory) {
    if (!finalHistory.find(e => e.at === event.at && e.event === event.event)) {
      finalHistory.push(event);
    }
  }

  // Sort by timestamp
  finalHistory.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

  // Limit total events
  const limitedHistory = finalHistory.slice(-MAX_HISTORY_EVENTS);

  // Save cleaned history
  writeJSON(historyPath, limitedHistory);

  // Update memory metadata
  if (!wf.memory) wf.memory = {};
  wf.memory.last_cleanup = now();
  wf.memory.cleaned_events = originalCount - limitedHistory.length;

  saveWorkflow(dir, wf);

  output({
    ok: true,
    message: 'History cleanup completed',
    run_id: resolvedRunId,
    original_events: originalCount,
    remaining_events: limitedHistory.length,
    cleaned_events: originalCount - limitedHistory.length,
    cutoff_days: days,
    cutoff_date: cutoffDate.toISOString(),
  });
}

// ── Status Command ─────────────────────────────────────────

/**
 * Show memory statistics.
 */
async function status(flags) {
  const { dir, run: runId } = flags;
  if (!dir) fail('--dir is required');

  let wf = loadWorkflow(dir);


  const wfRoot = getWorkflowRoot(dir);
  const memoryDir = join(wfRoot, 'memory');

  // Resolve run ID
  const resolvedRunId = await resolveRunId(dir, runId);

  // Load run state
  const runState = loadState(dir, resolvedRunId);

  // Load history from runs/{run-id}/history.json
  const history = readJSON(getHistoryPath(dir, resolvedRunId)) || [];

  // Calculate statistics
  const stats = {
    workflow: {
      name: wf.name,
      status: runState.status,
      total_steps: wf.steps.length,
      completed_steps: (runState.completed_steps || []).length,
    },
    run: {
      id: resolvedRunId,
      started_at: runState.started_at,
      updated_at: runState.updated_at,
    },
    memory: {
      initialized: wf.memory?.initialized_at || null,
      last_cleanup: wf.memory?.last_cleanup || null,
      artifact_count: Object.keys(wf.memory?.artifact_index || {}).length,
      summary_count: Object.keys(loadSummaryCache(dir)).length,
    },
    history: {
      total_events: history.length,
      oldest_event: history[0]?.at || null,
      newest_event: history.slice(-1)[0]?.at || null,
    },
    steps: {},
  };

  // Per-step statistics
  for (const step of wf.steps) {
    const stepState = runState.step_states?.[step.id] || {};
    const artifactPath = step.artifact
      ? join(wfRoot, 'runs', resolvedRunId, step.artifact)
      : null;
    stats.steps[step.id] = {
      name: step.name,
      status: stepState.status || 'pending',
      has_summary: !!stepState.summary,
      has_artifact: artifactPath ? existsSync(artifactPath) : false,
      key_decisions: (stepState.key_decisions || []).length,
    };
  }

  // Memory directory info
  if (existsSync(memoryDir)) {
    const memoryFiles = readdirSync(memoryDir).filter(f => f.endsWith('.json'));
    stats.memory.files = memoryFiles.length;
    stats.memory.files_list = memoryFiles;
  }

  output({
    ok: true,
    statistics: stats,
  });
}

// ── Main ──────────────────────────────────────────────────

const { command, flags } = parseArgs(process.argv.slice(2));

async function main() {
  switch (command) {
    case 'start':     start(flags); break;
    case 'summarize': await summarize(flags); break;
    case 'index':     index(flags); break;
    case 'cleanup':   await cleanup(flags); break;
    case 'status':    await status(flags); break;
    default:          fail(`Unknown command: ${command}. Use start|summarize|index|cleanup|status`);
  }
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
