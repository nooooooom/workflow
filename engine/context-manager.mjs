/**
 * Context Manager — Multi-Level Memory System
 *
 * Manages workflow context with hierarchical memory levels:
 * - Level 1 (Working Memory): Current step full content
 * - Level 2 (Session Memory): Recent step summaries + current step
 * - Level 3 (Full History): Complete workflow state
 *
 * Commands:
 *   compact    --dir <path> --run <run-id>                    Compress context for current step
 *   summary    --dir <path> --run <run-id> --step <id>        Generate summary for completed step
 *   load-level --dir <path> --run <run-id> --level <1|2|3>    Load context at specified memory level
 *   restore    --dir <path> --run <run-id> --step <id>        Restore full context from compressed state
 */

import {
  readJSON, writeJSON, workflowPath, getWorkflowRoot,
  now, parseArgs, output, fail,
  migrateToV3, listRuns, getStatePath, getSummaryCachePath,
  ensureMemoryDir, detectSchema, getHistoryPath,
  getCuratedMemoryPath, getSnapshotPath,
  resolveArtifact,
} from './utils.mjs';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

// ── Constants ─────────────────────────────────────────────

const MEMORY_LEVELS = {
  1: 'working',    // Current step only
  2: 'session',    // Recent summaries + current
  3: 'full',       // Complete history
};

const MAX_SUMMARY_LENGTH = 500;  // Max chars for step summary
const MAX_KEY_DECISIONS = 5;     // Max key decisions per step
const RECENT_STEPS_COUNT = 3;    // Number of recent steps to include in session memory

// Character limits per memory type (inspired by hermes-agent)
const CHAR_LIMITS = {
  workflow: 2000,  // WORKFLOW.md - workflow-specific curated notes
  memory: 2200,    // MEMORY.md - facts and knowledge about this workflow
  user: 1375,      // USER.md - user preferences for this workflow
};

const DEFAULT_CHAR_LIMIT = CHAR_LIMITS.workflow;
const ENTRY_DELIMITER = '\n§\n'; // Entry separator (hermes-agent style)

// Structured summary template (inspired by hermes-agent context compression)
const SUMMARY_TEMPLATE = {
  active_task: {
    description: '当前步骤要完成的任务，从指令文件中提取',
    required: true,
  },
  completed_actions: {
    description: '按顺序列出完成的具体动作，包含文件路径、命令、结果',
    required: true,
    format: 'array',
  },
  key_decisions: {
    description: '做出的关键决策及原因',
    required: true,
    format: 'array',
  },
  artifacts: {
    description: '产出的文件及简述',
    required: false,
    format: 'array',
  },
  remaining_work: {
    description: '未完成的工作，传递给下一步',
    required: false,
  },
};

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
  const fullPath = join(wfRoot, 'runs', runId, artifactPath);
  if (!existsSync(fullPath)) return null;
  return readFileSync(fullPath, 'utf-8');
}

function getInstructionContent(dir, instructionPath) {
  const wfRoot = getWorkflowRoot(dir);
  const fullPath = join(wfRoot, instructionPath);
  if (!existsSync(fullPath)) return null;
  return readFileSync(fullPath, 'utf-8');
}

function loadSummaryCache(dir) {
  const cachePath = getSummaryCachePath(dir);
  return readJSON(cachePath) || {};
}

function saveSummaryCache(dir, cache) {
  ensureMemoryDir(dir);
  writeJSON(getSummaryCachePath(dir), cache);
}

function loadHistory(dir, runId) {
  return readJSON(getHistoryPath(dir, runId)) || [];
}

// ── Compact Command ───────────────────────────────────────

/**
 * Compress context for current workflow state.
 * Returns: current step full + recent summaries + earlier index
 */
function compact(flags) {
  const { dir, run: runId } = flags;
  if (!dir) fail('--dir is required');
  if (!runId) fail('--run is required');

  const wf = loadWorkflow(dir);
  const state = loadState(dir, runId);

  const currentStepId = state.current_step;

  if (!currentStepId) {
    output({
      ok: true,
      message: 'No active step - workflow not in progress',
      context: {
        workflow_name: wf.name,
        status: state.status,
        completed_steps: (state.completed_steps || []).length,
        total_steps: wf.steps.length,
      },
    });
    return;
  }

  const currentStep = getStep(wf, currentStepId);
  const currentStepState = state.step_states[currentStepId] || {};

  // Get artifact content for current step
  const artifactContent = currentStep.artifact
    ? getArtifactContent(dir, runId, currentStep)
    : null;

  // Build recent summaries (last 3 completed steps)
  const completedIds = state.completed_steps || [];
  const recentCompleted = completedIds.slice(-RECENT_STEPS_COUNT);

  const summaryCache = loadSummaryCache(dir);

  const recentSummaries = recentCompleted.map(id => {
    const step = wf.steps.find(s => s.id === id);
    const stepState = state.step_states[id] || {};
    const cached = summaryCache[id] || {};

    // Prefer structured_summary if available
    const structuredSummary = cached.structured_summary || stepState.structured_summary;

    return {
      id,
      name: step?.name || `Step ${id}`,
      // Use structured summary fields if available, otherwise fallback to legacy
      summary: structuredSummary
        ? `[${structuredSummary.active_task}] ${(structuredSummary.completed_actions || []).slice(0, 2).join('; ')}`
        : (cached.summary || stepState.summary || 'No summary available'),
      key_decisions: structuredSummary?.key_decisions || cached.key_decisions || stepState.key_decisions || [],
      artifacts: step?.artifact ? [step.artifact] : [],
      structured_summary: structuredSummary || null,
      remaining_work: structuredSummary?.remaining_work || null,
    };
  });

  // Build earlier steps index
  const earlierIds = completedIds.slice(0, -RECENT_STEPS_COUNT);
  const earlierIndex = earlierIds.map(id => {
    const stepState = state.step_states[id] || {};
    const step = wf.steps.find(s => s.id === id);
    const cached = summaryCache[id] || {};
    return {
      id,
      name: step?.name || `Step ${id}`,
      status: 'completed',
      has_summary: !!(cached.summary || stepState.summary),
    };
  });

  // Calculate context size reduction
  const history = loadHistory(dir, runId);
  const fullHistorySize = JSON.stringify(history).length;
  const compressedSize = JSON.stringify({
    current: artifactContent || '',
    recent: recentSummaries,
    earlier: earlierIndex,
  }).length;

  // Load curated memory (WORKFLOW.md) if exists
  let curatedMemory = null;
  const curatedPath = getCuratedMemoryPath(dir);
  if (existsSync(curatedPath)) {
    const cm = new CuratedMemory(dir);
    cm.load();
    if (cm.entries.length > 0) {
      curatedMemory = {
        entries: cm.entries,
        formatted: cm.formatBlock(),
        char_limit: cm.charLimit,
        usage: `${Math.round((cm.entries.join(ENTRY_DELIMITER).length / cm.charLimit) * 100)}%`,
      };
    }
  }

  output({
    ok: true,
    compression: {
      original_bytes: fullHistorySize,
      compressed_bytes: compressedSize,
      reduction_percent: Math.round((1 - compressedSize / Math.max(fullHistorySize, 1)) * 100),
    },
    context: {
      // Level 1: Current step full content
      current_step: {
        id: currentStepId,
        name: currentStep.name,
        status: currentStepState.status || 'unknown',
        instruction: currentStep.instruction,
        artifact: currentStep.artifact,
        artifact_content: artifactContent,
        dependsOn: currentStep.dependsOn || [],
        started_at: currentStepState.started_at,
        loop_iteration: currentStepState.loop_iteration || 0,
      },

      // Level 2: Recent step summaries
      recent_summaries: recentSummaries,

      // Level 3: Earlier steps index
      earlier_index: earlierIndex,

      // Workflow metadata
      workflow: {
        name: wf.name,
        status: state.status,
        goal: wf.goal || null,
      },
    },
    // Curated memory (WORKFLOW.md) - persistent notes across steps
    curated_memory: curatedMemory,
    usage_hint: 'Use load-level --level 1|2|3 to get different detail levels',
  });
}

// ── Summary Command ───────────────────────────────────────

/**
 * Generate summary for a completed step.
 * Supports three modes:
 *   - default: Auto-generate using regex extraction
 *   - --template: Output structured template for orchestrator to fill
 *   - --save: Save orchestrator-provided structured summary
 */
function summary(flags) {
  const { dir, run: runId, step: stepId, template, save } = flags;
  if (!dir) fail('--dir is required');
  if (!runId) fail('--run is required');
  if (!stepId) fail('--step is required');

  // Route to appropriate handler
  if (template) {
    return summaryTemplate(dir, runId, stepId);
  }
  if (save) {
    return summarySave(dir, runId, stepId, save);
  }

  // Default: auto-generate
  const wf = loadWorkflow(dir);
  const state = loadState(dir, runId);
  const stepState = state.step_states[stepId] || {};

  // Check if step is completed or gate_pending
  if (!['completed', 'gate_pending'].includes(stepState.status)) {
    fail(`Cannot generate summary: step ${stepId} status is '${stepState.status}', expected 'completed' or 'gate_pending'`);
  }

  const step = getStep(wf, stepId);

  // Get artifact content
  const artifactContent = step.artifact
    ? getArtifactContent(dir, runId, step)
    : null;

  if (!artifactContent) {
    output({
      ok: true,
      warning: 'No artifact content found',
      step: {
        id: stepId,
        name: step.name,
        summary: `Step "${step.name}" completed without artifact`,
        key_decisions: [],
        artifacts: [],
      },
    });
    return;
  }

  // Extract summary from artifact (first few paragraphs or sections)
  const lines = artifactContent.split('\n').filter(l => l.trim());
  const summaryText = extractSummary(lines);

  // Extract key decisions (look for decision markers)
  const keyDecisions = extractKeyDecisions(artifactContent);

  // Find related artifacts
  const artifacts = [step.artifact].filter(Boolean);

  // Save summary to run state
  stepState.summary = summaryText;
  stepState.key_decisions = keyDecisions;
  saveState(dir, runId, state);

  // Save to summary cache
  const cache = loadSummaryCache(dir);
  cache[stepId] = {
    summary: summaryText,
    key_decisions: keyDecisions,
    artifacts,
    generated_at: now(),
  };
  saveSummaryCache(dir, cache);

  output({
    ok: true,
    step: {
      id: stepId,
      name: step.name,
      summary: summaryText,
      key_decisions: keyDecisions,
      artifacts: artifacts,
      generated_at: now(),
    },
    message: `Summary generated for step ${stepId}`,
  });
}

/**
 * Extract summary from content lines.
 */
function extractSummary(lines) {
  // Find first substantive content
  const contentLines = lines.filter(l =>
    !l.startsWith('#') &&
    !l.startsWith('---') &&
    l.trim().length > 20
  );

  if (contentLines.length === 0) {
    return 'Summary not available - no content found';
  }

  // Take first few meaningful lines, truncate if needed
  const summaryLines = contentLines.slice(0, 3);
  let summary = summaryLines.join(' ').trim();

  if (summary.length > MAX_SUMMARY_LENGTH) {
    summary = summary.slice(0, MAX_SUMMARY_LENGTH - 3) + '...';
  }

  return summary;
}

/**
 * Extract key decisions from content.
 */
function extractKeyDecisions(content) {
  const decisions = [];

  // Pattern 1: Explicit decision markers
  const decisionPatterns = [
    /决定[：:]\s*(.+)/g,
    /决策[：:]\s*(.+)/g,
    /选择[：:]\s*(.+)/g,
    /Decision[：:]\s*(.+)/gi,
    /Chose[：:]\s*(.+)/gi,
  ];

  for (const pattern of decisionPatterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const decision = match[1].trim();
      if (decision && decisions.length < MAX_KEY_DECISIONS) {
        decisions.push(decision.slice(0, 100));
      }
    }
  }

  // Pattern 2: Checkbox items (decisions made)
  const checkboxPattern = /- \[x\]\s*(.+)/g;
  let match;
  while ((match = checkboxPattern.exec(content)) !== null && decisions.length < MAX_KEY_DECISIONS) {
    decisions.push(match[1].trim().slice(0, 100));
  }

  return decisions;
}

// ── Structured Summary Functions ──────────────────────────

/**
 * Output a structured summary template for the orchestrator to fill.
 * Inspired by hermes-agent's context compression template.
 */
function summaryTemplate(dir, runId, stepId) {
  const wf = loadWorkflow(dir);
  const state = loadState(dir, runId);
  const stepState = state.step_states[stepId] || {};
  const step = getStep(wf, stepId);

  // Get artifact content for context
  const artifactContent = step.artifact
    ? getArtifactContent(dir, runId, step)
    : null;

  // Get instruction content for active_task hint
  const instructionContent = step.instruction
    ? getInstructionContent(dir, step.instruction)
    : null;

  // Pre-fill with regex extraction as hints
  const keyDecisions = artifactContent ? extractKeyDecisions(artifactContent) : [];
  const lines = artifactContent ? artifactContent.split('\n').filter(l => l.trim()) : [];
  const autoSummary = extractSummary(lines);

  // Build template with hints
  const template = {
    step_id: Number(stepId),
    step_name: step.name,
    template_version: '1.0',
    fields: {
      active_task: {
        value: null,
        description: SUMMARY_TEMPLATE.active_task.description,
        required: true,
        hint: instructionContent
          ? instructionContent.split('\n').find(l => l.startsWith('# '))?.replace(/^# /, '') || step.name
          : step.name,
      },
      completed_actions: {
        value: [],
        description: SUMMARY_TEMPLATE.completed_actions.description,
        required: true,
        format: 'array of strings, each describing one action',
        hint: 'Example: ["READ engine/session.mjs - understood existing structure", "EDIT engine/session.mjs:45 - added new function"]',
      },
      key_decisions: {
        value: keyDecisions.length > 0 ? keyDecisions : [],
        description: SUMMARY_TEMPLATE.key_decisions.description,
        required: true,
        format: 'array of strings',
        hint: keyDecisions.length > 0 ? 'Auto-extracted (verify/edit)' : 'List key decisions made',
      },
      artifacts: {
        value: step.artifact ? [{ path: step.artifact, description: null }] : [],
        description: SUMMARY_TEMPLATE.artifacts.description,
        required: false,
        format: 'array of {path, description}',
      },
      remaining_work: {
        value: null,
        description: SUMMARY_TEMPLATE.remaining_work.description,
        required: false,
        hint: 'What needs to be done next? Leave null if complete.',
      },
    },
    auto_extracted: {
      summary: autoSummary,
      key_decisions: keyDecisions,
    },
    artifact_preview: artifactContent ? artifactContent.slice(0, 1000) + (artifactContent.length > 1000 ? '...' : '') : null,
  };

  output({
    ok: true,
    mode: 'template',
    step_id: stepId,
    step_name: step.name,
    template,
    usage: 'Fill the template.fields values, then call: context-manager summary --dir <path> --run <run-id> --step <id> --save \'<json>\'',
  });
}

/**
 * Save an orchestrator-provided structured summary.
 */
function summarySave(dir, runId, stepId, summaryJson) {
  // Parse the provided JSON
  let structuredSummary;
  try {
    structuredSummary = typeof summaryJson === 'string' ? JSON.parse(summaryJson) : summaryJson;
  } catch (e) {
    fail(`Invalid JSON for --save: ${e.message}`);
  }

  // Validate required fields
  const required = ['active_task', 'completed_actions', 'key_decisions'];
  for (const field of required) {
    if (!structuredSummary[field]) {
      fail(`Missing required field: ${field}`);
    }
  }

  const wf = loadWorkflow(dir);
  const state = loadState(dir, runId);
  const stepState = state.step_states[stepId] || {};
  const step = getStep(wf, stepId);

  // Build legacy summary for backward compatibility
  const legacySummary = [
    `Task: ${structuredSummary.active_task}`,
    `Actions: ${(structuredSummary.completed_actions || []).slice(0, 3).join('; ')}`,
    `Decisions: ${(structuredSummary.key_decisions || []).slice(0, 3).join('; ')}`,
  ].join(' | ').slice(0, MAX_SUMMARY_LENGTH);

  // Save structured summary to step state
  stepState.structured_summary = {
    ...structuredSummary,
    saved_at: now(),
    version: '1.0',
  };
  // Also update legacy fields for backward compatibility
  stepState.summary = legacySummary;
  stepState.key_decisions = structuredSummary.key_decisions || [];

  saveState(dir, runId, state);

  // Save to summary cache
  const cache = loadSummaryCache(dir);
  cache[stepId] = {
    summary: legacySummary,
    structured_summary: stepState.structured_summary,
    key_decisions: structuredSummary.key_decisions || [],
    artifacts: (structuredSummary.artifacts || []).map(a => a.path || a),
    generated_at: now(),
  };
  saveSummaryCache(dir, cache);

  output({
    ok: true,
    mode: 'save',
    step_id: stepId,
    step_name: step.name,
    structured_summary: stepState.structured_summary,
    legacy_summary: legacySummary,
    message: `Structured summary saved for step ${stepId}`,
  });
}

// ── Load-Level Command ─────────────────────────────────────

/**
 * Load context at specified memory level.
 */
function loadLevel(flags) {
  const { dir, run: runId, level } = flags;
  if (!dir) fail('--dir is required');
  if (!runId) fail('--run is required');
  if (!level) fail('--level is required (1, 2, or 3)');

  const levelNum = Number(level);
  if (![1, 2, 3].includes(levelNum)) {
    fail('Invalid level: must be 1 (working), 2 (session), or 3 (full)');
  }

  const wf = loadWorkflow(dir);
  const state = loadState(dir, runId);

  const currentStepId = state.current_step;

  let context = {
    level: levelNum,
    level_name: MEMORY_LEVELS[levelNum],
    workflow: {
      name: wf.name,
      status: state.status,
      goal: wf.goal || null,
    },
  };

  const summaryCache = loadSummaryCache(dir);

  switch (levelNum) {
    case 1: // Working Memory - current step only
      if (!currentStepId) {
        context.message = 'No active step';
        context.current_step = null;
      } else {
        const step = getStep(wf, currentStepId);
        const stepState = state.step_states[currentStepId] || {};
        const artifactContent = step.artifact
          ? getArtifactContent(dir, runId, step)
          : null;

        context.current_step = {
          id: currentStepId,
          name: step.name,
          status: stepState.status,
          instruction: step.instruction,
          instruction_content: step.instruction
            ? getInstructionContent(dir, step.instruction)
            : null,
          artifact: step.artifact,
          artifact_content: artifactContent,
          provider: step.provider,
          gate: step.gate,
          loop: step.loop,
          dependsOn: step.dependsOn || [],
        };
        context.message = 'Working memory: current step context loaded';
      }
      break;

    case 2: { // Session Memory - recent summaries + current
      const completedIds = state.completed_steps || [];
      const recentIds = completedIds.slice(-RECENT_STEPS_COUNT);

      context.recent_steps = recentIds.map(id => {
        const step = wf.steps.find(s => s.id === id);
        const stepState = state.step_states[id] || {};
        const cached = summaryCache[id] || {};
        return {
          id,
          name: step?.name || `Step ${id}`,
          summary: cached.summary || stepState.summary || 'No summary',
          key_decisions: cached.key_decisions || stepState.key_decisions || [],
          artifacts: step?.artifact ? [step.artifact] : [],
          completed_at: stepState.completed_at,
        };
      });

      if (currentStepId && !(state.completed_steps || []).includes(currentStepId)) {
        const step = getStep(wf, currentStepId);
        const stepState = state.step_states[currentStepId] || {};
        const cached = summaryCache[currentStepId] || {};
        context.current_step = {
          id: currentStepId,
          name: step.name,
          status: stepState.status,
          summary: cached.summary || stepState.summary || null,
          key_decisions: cached.key_decisions || stepState.key_decisions || [],
        };
      }

      context.message = `Session memory: ${context.recent_steps.length} recent steps loaded`;
      break;
    }

    case 3: { // Full History
      context.steps = wf.steps.map(step => {
        const stepState = state.step_states[step.id] || {};
        const cached = summaryCache[step.id] || {};
        const artifactContent = step.artifact
          ? getArtifactContent(dir, runId, step)
          : null;

        return {
          id: step.id,
          name: step.name,
          status: stepState.status || 'pending',
          summary: cached.summary || stepState.summary || null,
          key_decisions: cached.key_decisions || stepState.key_decisions || [],
          artifacts: step.artifact ? [step.artifact] : [],
          artifact_content: artifactContent,
          instruction: step.instruction,
          dependsOn: step.dependsOn || [],
          gate_result: stepState.gate_result,
          loop_iteration: stepState.loop_iteration || 0,
          started_at: stepState.started_at,
          completed_at: stepState.completed_at,
        };
      });

      const history = loadHistory(dir, runId);
      context.history = history.slice(-50); // Last 50 history events
      context.message = `Full history: ${context.steps.length} steps loaded`;
      break;
    }
  }

  output({
    ok: true,
    ...context,
  });
}

// ── Restore Command ───────────────────────────────────────

/**
 * Restore full context for a specific step from compressed state.
 */
function restore(flags) {
  const { dir, run: runId, step: stepId } = flags;
  if (!dir) fail('--dir is required');
  if (!runId) fail('--run is required');
  if (!stepId) fail('--step is required');

  const wf = loadWorkflow(dir);
  const state = loadState(dir, runId);
  const stepState = state.step_states[stepId] || {};

  const step = getStep(wf, stepId);

  // Get all related content
  const artifactContent = step.artifact
    ? getArtifactContent(dir, runId, step)
    : null;

  const instructionContent = step.instruction
    ? getInstructionContent(dir, step.instruction)
    : null;

  // Find related history events
  const history = loadHistory(dir, runId);
  const stepHistory = history.filter(h =>
    h.step === Number(stepId) || h.step === String(stepId)
  );

  // Find gate results - use run directory
  const gateResults = [];
  const wfRoot = getWorkflowRoot(dir);
  const gateDir = join(wfRoot, 'runs', runId, 'gates');
  if (existsSync(gateDir)) {
    const gateFiles = readdirSync(gateDir).filter(f => f.includes(`step-${stepId}`));
    for (const file of gateFiles) {
      const gateContent = readFileSync(join(gateDir, file), 'utf-8');
      try {
        gateResults.push(JSON.parse(gateContent));
      } catch {}
    }
  }

  const summaryCache = loadSummaryCache(dir);
  const cached = summaryCache[stepId] || {};

  output({
    ok: true,
    restored_step: {
      id: stepId,
      name: step.name,
      status: stepState.status || 'pending',

      // Full content
      instruction: step.instruction,
      instruction_content: instructionContent,
      artifact: step.artifact,
      artifact_content: artifactContent,

      // Summaries
      summary: cached.summary || stepState.summary || null,
      key_decisions: cached.key_decisions || stepState.key_decisions || [],
      artifacts: step.artifact ? [step.artifact] : [],

      // Configuration
      provider: step.provider,
      gate: step.gate,
      loop: step.loop,
      dependsOn: step.dependsOn || [],

      // State
      gate_result: stepState.gate_result,
      loop_iteration: stepState.loop_iteration || 0,
      started_at: stepState.started_at,
      completed_at: stepState.completed_at,
      failed_at: stepState.failed_at,
      fail_reason: stepState.fail_reason,
    },
    history: stepHistory,
    gate_results: gateResults,
    message: `Full context restored for step ${stepId}`,
  });
}

// ── Curated Memory (hermes-agent inspired) ────────────────

/**
 * Bounded curated memory with file persistence.
 * Supports multiple memory targets: WORKFLOW.md, MEMORY.md, USER.md.
 *
 * Design principles (from hermes-agent):
 * - Bounded: entries are capped by char_limit (different per target)
 * - Curated: LLM adds/replaces/removes entries
 * - Frozen snapshot: loaded at step start, mutations don't affect snapshot
 */
class CuratedMemory {
  constructor(dir, target = 'workflow') {
    this.dir = dir;
    this.target = target;
    this.entries = [];
    this.charLimit = CHAR_LIMITS[target] || DEFAULT_CHAR_LIMIT;
  }

  _getPath() {
    return getCuratedMemoryPath(this.dir, this.target);
  }

  /**
   * Load entries from WORKFLOW.md.
   */
  load() {
    const path = this._getPath();
    if (!existsSync(path)) {
      this.entries = [];
      return;
    }

    try {
      const raw = readFileSync(path, 'utf-8');
      if (!raw.trim()) {
        this.entries = [];
        return;
      }

      // Parse: skip header block, split by delimiter
      const lines = raw.split('\n');
      let contentStart = 0;

      // Find end of header (after separator line)
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('═') && i > 0) {
          contentStart = i + 1;
          break;
        }
      }

      const content = lines.slice(contentStart).join('\n').trim();
      if (!content) {
        this.entries = [];
        return;
      }

      this.entries = content.split(ENTRY_DELIMITER)
        .map(e => e.trim())
        .filter(e => e.length > 0);

      // Deduplicate
      this.entries = [...new Set(this.entries)];
    } catch {
      this.entries = [];
    }
  }

  /**
   * Save entries to target file with header.
   */
  save() {
    ensureMemoryDir(this.dir);
    const path = this._getPath();

    const currentChars = this._charCount();
    const pct = Math.min(100, Math.round((currentChars / this.charLimit) * 100));

    const label = this._getLabel();
    const header = [
      '═'.repeat(46),
      `${label} [${pct}% — ${currentChars.toLocaleString()}/${this.charLimit.toLocaleString()} chars]`,
      '═'.repeat(46),
    ].join('\n');

    const content = this.entries.length > 0
      ? header + '\n' + this.entries.join(ENTRY_DELIMITER)
      : '';

    writeFileSync(path, content, 'utf-8');
  }

  /**
   * Get human-readable label for the target type.
   */
  _getLabel() {
    const labels = {
      workflow: 'WORKFLOW MEMORY',
      memory: 'MEMORY (your personal notes)',
      user: 'USER PROFILE (who the user is)',
    };
    return labels[this.target] || 'MEMORY';
  }

  _charCount() {
    if (this.entries.length === 0) return 0;
    return this.entries.join(ENTRY_DELIMITER).length;
  }

  /**
   * Add a new entry.
   */
  add(content) {
    content = content.trim();
    if (!content) {
      return { success: false, error: 'Content cannot be empty.' };
    }

    // Check for duplicate
    if (this.entries.includes(content)) {
      return this._successResponse('Entry already exists (no duplicate added).');
    }

    // Check char limit
    const newEntries = [...this.entries, content];
    const newTotal = newEntries.join(ENTRY_DELIMITER).length;

    if (newTotal > this.charLimit) {
      const current = this._charCount();
      return {
        success: false,
        error: `Memory at ${current.toLocaleString()}/${this.charLimit.toLocaleString()} chars. ` +
          `Adding this entry (${content.length} chars) would exceed the limit. ` +
          `Replace or remove existing entries first.`,
        current_entries: this.entries,
        usage: `${current.toLocaleString()}/${this.charLimit.toLocaleString()}`,
      };
    }

    this.entries.push(content);
    this.save();
    return this._successResponse('Entry added.');
  }

  /**
   * Replace entry containing old_text with new content.
   */
  replace(oldText, newContent) {
    oldText = oldText.trim();
    newContent = newContent.trim();

    if (!oldText) {
      return { success: false, error: 'old_text cannot be empty.' };
    }
    if (!newContent) {
      return { success: false, error: 'new_content cannot be empty. Use remove to delete entries.' };
    }

    const matches = this.entries
      .map((e, i) => ({ index: i, entry: e }))
      .filter(({ entry }) => entry.includes(oldText));

    if (matches.length === 0) {
      return { success: false, error: `No entry matched '${oldText}'.` };
    }

    if (matches.length > 1) {
      const previews = matches.map(m => m.entry.slice(0, 80) + (m.entry.length > 80 ? '...' : ''));
      return {
        success: false,
        error: `Multiple entries matched '${oldText}'. Be more specific.`,
        matches: previews,
      };
    }

    // Check char limit after replacement
    const testEntries = [...this.entries];
    testEntries[matches[0].index] = newContent;
    const newTotal = testEntries.join(ENTRY_DELIMITER).length;

    if (newTotal > this.charLimit) {
      return {
        success: false,
        error: `Replacement would put memory at ${newTotal.toLocaleString()}/${this.charLimit.toLocaleString()} chars. ` +
          `Shorten the new content or remove other entries first.`,
      };
    }

    this.entries[matches[0].index] = newContent;
    this.save();
    return this._successResponse('Entry replaced.');
  }

  /**
   * Remove entry containing old_text.
   */
  remove(oldText) {
    oldText = oldText.trim();
    if (!oldText) {
      return { success: false, error: 'old_text cannot be empty.' };
    }

    const matches = this.entries
      .map((e, i) => ({ index: i, entry: e }))
      .filter(({ entry }) => entry.includes(oldText));

    if (matches.length === 0) {
      return { success: false, error: `No entry matched '${oldText}'.` };
    }

    if (matches.length > 1) {
      const previews = matches.map(m => m.entry.slice(0, 80) + (m.entry.length > 80 ? '...' : ''));
      return {
        success: false,
        error: `Multiple entries matched '${oldText}'. Be more specific.`,
        matches: previews,
      };
    }

    this.entries.splice(matches[0].index, 1);
    this.save();
    return this._successResponse('Entry removed.');
  }

  /**
   * Get formatted block for display.
   */
  formatBlock() {
    if (this.entries.length === 0) return null;

    const currentChars = this._charCount();
    const pct = Math.min(100, Math.round((currentChars / this.charLimit) * 100));

    const label = this._getLabel();
    const header = [
      '═'.repeat(46),
      `${label} [${pct}% — ${currentChars.toLocaleString()}/${this.charLimit.toLocaleString()} chars]`,
      '═'.repeat(46),
    ].join('\n');

    return header + '\n' + this.entries.join(ENTRY_DELIMITER);
  }

  _successResponse(message) {
    const current = this._charCount();
    const pct = Math.min(100, Math.round((current / this.charLimit) * 100));

    return {
      success: true,
      message,
      entries: this.entries,
      usage: `${pct}% — ${current.toLocaleString()}/${this.charLimit.toLocaleString()} chars`,
      entry_count: this.entries.length,
    };
  }
}

// ── Memory Command ────────────────────────────────────────

/**
 * Curated memory operations: add, replace, remove.
 * Supports --target to select memory type: workflow (default), memory, user.
 */
function memory(flags) {
  const { dir, action, content, 'old-text': oldText, target } = flags;
  if (!dir) fail('--dir is required');
  if (!action) fail('--action is required (add, replace, remove)');

  // Validate target
  const targetValue = target || 'workflow';
  if (!['workflow', 'memory', 'user'].includes(targetValue)) {
    fail(`Invalid --target: ${targetValue}. Must be workflow, memory, or user.`);
  }

  const mem = new CuratedMemory(dir, targetValue);
  mem.load();

  let result;
  switch (action) {
    case 'add':
      if (!content) fail('--content is required for add action');
      result = mem.add(content);
      break;
    case 'replace':
      if (!oldText) fail('--old-text is required for replace action');
      if (!content) fail('--content is required for replace action');
      result = mem.replace(oldText, content);
      break;
    case 'remove':
      if (!oldText) fail('--old-text is required for remove action');
      result = mem.remove(oldText);
      break;
    default:
      fail(`Unknown action: ${action}. Use add, replace, or remove.`);
  }

  output({ ok: result.success, target: targetValue, ...result });
}

// ── Snapshot Command ──────────────────────────────────────

/**
 * Generate and save a frozen snapshot for the current step.
 * Called at step start to freeze context.
 */
function snapshot(flags) {
  const { dir, run: runId } = flags;
  if (!dir) fail('--dir is required');
  if (!runId) fail('--run is required');

  const wf = loadWorkflow(dir);
  const state = loadState(dir, runId);

  // Load curated memory
  const mem = new CuratedMemory(dir);
  mem.load();

  // Load summary cache
  const summaryCache = loadSummaryCache(dir);

  // Get recent completed steps
  const completedIds = state.completed_steps || [];
  const recentIds = completedIds.slice(-RECENT_STEPS_COUNT);

  const recentSummaries = recentIds.map(id => {
    const step = wf.steps.find(s => s.id === id);
    const stepState = state.step_states[id] || {};
    const cached = summaryCache[id] || {};
    return {
      id,
      name: step?.name || `Step ${id}`,
      summary: cached.summary || stepState.summary || 'No summary',
      key_decisions: cached.key_decisions || stepState.key_decisions || [],
    };
  });

  // Build snapshot
  const snapshotData = {
    frozen_at: now(),
    workflow_name: wf.name,
    run_id: runId,
    curated_memory: {
      entries: mem.entries,
      char_limit: mem.charLimit,
      formatted: mem.formatBlock(),
    },
    recent_summaries: recentSummaries,
    current_step: state.current_step,
    completed_steps: completedIds,
  };

  // Save snapshot to run memory directory
  const snapshotPath = getSnapshotPath(dir, runId);
  const snapshotDir = dirname(snapshotPath);
  if (!existsSync(snapshotDir)) {
    mkdirSync(snapshotDir, { recursive: true });
  }
  writeFileSync(snapshotPath, JSON.stringify(snapshotData, null, 2), 'utf-8');

  output({
    ok: true,
    snapshot_path: snapshotPath.replace(getWorkflowRoot(dir) + '/', ''),
    curated_memory: snapshotData.curated_memory,
    recent_summaries: recentSummaries,
    current_step: state.current_step,
    frozen_at: snapshotData.frozen_at,
    message: 'Snapshot generated and saved',
  });
}

// ── Content Extraction (moved from context-compressor.mjs) ────

/**
 * Extract key insights from content.
 */
export function extractKeyInsights(content) {
  if (!content) return [];

  const insights = [];
  const lines = content.split('\n');

  // Pattern matching for insights
  const patterns = [
    /^[-*]\s*(.+)/,                    // List items
    /^>\s*(.+)/,                       // Blockquotes
    /^(发现|决策|结论|Decided|Found|Conclusion)[:：]\s*(.+)/i,  // Key markers
    /^#+\s*(.+)/,                      // Headers
    /\*\*([^*]+)\*\*/,                 // Bold text
  ];

  for (const line of lines) {
    for (const pattern of patterns) {
      const match = line.match(pattern);
      if (match) {
        const text = match[1] || match[2] || '';
        if (text.length > 10 && text.length < 200) {
          insights.push(text.trim());
        }
      }
    }
  }

  return [...new Set(insights)].slice(0, 10);
}

/**
 * Extract decisions from content.
 */
export function extractDecisions(content) {
  if (!content) return [];

  const decisions = [];
  const patterns = [
    /决定[：:]\s*(.+)/g,
    /决策[：:]\s*(.+)/g,
    /选择[：:]\s*(.+)/g,
    /Decision[：:]\s*(.+)/gi,
    /Chose[：:]\s*(.+)/gi,
    /结论[：:]\s*(.+)/g,
    /✅\s*(.+)/g,
    /- \[x\]\s*(.+)/g,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const decision = match[1].trim();
      if (decision.length > 5 && decision.length < 150) {
        decisions.push(decision);
      }
    }
  }

  return [...new Set(decisions)];
}

// ── Main ──────────────────────────────────────────────────

// Only run main when executed directly (not when imported)
if (import.meta.url === `file://${process.argv[1]}`) {
  const { command, flags } = parseArgs(process.argv.slice(2));

  switch (command) {
    case 'compact':    compact(flags); break;
    case 'summary':    summary(flags); break;
    case 'load-level': loadLevel(flags); break;
    case 'restore':    restore(flags); break;
    case 'memory':     memory(flags); break;
    case 'snapshot':   snapshot(flags); break;
    default:           fail(`Unknown command: ${command}. Use compact|summary|load-level|restore|memory|snapshot`);
  }
}
