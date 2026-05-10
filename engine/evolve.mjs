/**
 * Workflow Engine — Evolution System
 *
 * Extracts lessons learned from completed workflows and injects them
 * into step instruction files for future iterations.
 *
 * Core idea: each workflow iteration should make the next one easier.
 *
 * Commands:
 *   extract       --dir <path> --run <run-id>            Extract lessons from all completed steps
 *   extract-step  --dir <path> --run <run-id> --step <id> Extract lessons from a single step (incremental)
 *   inject        --dir <path> [--target <path>]         Inject lessons into step instruction files
 *   archive       --dir <path> --run <run-id> --summary <text>  Archive run and reset for reuse
 *   status        --dir <path>                           Show evolution statistics
 *
 * Usage:
 *   node engine/evolve.mjs extract --dir ".workflows/my-workflow" --run "run-xxx"
 *   node engine/evolve.mjs extract-step --dir ".workflows/my-workflow" --run "run-xxx" --step 1
 *   node engine/evolve.mjs inject --dir ".workflows/my-workflow"
 *   node engine/evolve.mjs archive --dir ".workflows/my-workflow" --run "run-xxx"
 */

import {
  readJSON, writeJSON, workflowPath, getWorkflowRoot,
  now, parseArgs, output, fail,
  migrateToV3, listRuns, getStatePath, getHistoryPath,
  detectSchema, resolveArtifact,
} from './utils.mjs';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, cpSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { extractKeyInsights, extractDecisions } from './context-manager.mjs';
import { scanContent, formatScanResult } from './security-scanner.mjs';

// ── Constants ─────────────────────────────────────────────

const MAX_LESSONS_PER_STEP = 5;
const EVOLVE_START = '<!-- evolve:start -->';
const EVOLVE_END = '<!-- evolve:end -->';

// ── Helpers ───────────────────────────────────────────────

function loadWorkflow(dir) {
  if (!dir) fail('Workflow directory is required');
  const wf = readJSON(workflowPath(dir));
  if (!wf) fail(`No workflow found at ${dir}`);
  return wf;
}

function loadState(dir, runId) {
  if (!runId) fail('--run is required');
  const state = readJSON(getStatePath(dir, runId));
  if (!state) fail(`Run "${runId}" not found`);
  return state;
}

function getAbsDir(dir) {
  return getWorkflowRoot(dir);
}

function readArtifact(dir, runId, artifactOrStep) {
  // Support both old call signature (artifact string) and new (step object)
  let artifactPath;
  if (typeof artifactOrStep === 'string') {
    artifactPath = artifactOrStep;
  } else if (artifactOrStep && typeof artifactOrStep === 'object') {
    const resolved = resolveArtifact(artifactOrStep.artifact, artifactOrStep.id);
    artifactPath = resolved.path;
  } else {
    return null;
  }
  if (!artifactPath) return null;
  const absDir = getAbsDir(dir);
  const fullPath = join(absDir, 'runs', runId, artifactPath);
  if (!existsSync(fullPath)) return null;
  return readFileSync(fullPath, 'utf-8');
}

function readGateResults(dir, runId) {
  const absDir = getAbsDir(dir);
  const gatesDir = join(absDir, 'runs', runId, 'gates');
  if (!existsSync(gatesDir)) return [];

  const results = [];
  for (const file of readdirSync(gatesDir).filter(f => f.endsWith('.json'))) {
    try {
      const gate = JSON.parse(readFileSync(join(gatesDir, file), 'utf-8'));
      results.push({ file, ...gate });
    } catch { /* skip malformed */ }
  }
  return results;
}

function loadHistory(dir, runId) {
  return readJSON(getHistoryPath(dir, runId)) || [];
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// ── Lesson Extraction ─────────────────────────────────────

/**
 * Extract failures/pitfalls from gate results and workflow history.
 */
function extractFailures(history, gateResults) {
  const failures = [];

  // From gate failures
  for (const gate of gateResults) {
    if (gate.result === 'fail' && gate.findings) {
      for (const finding of gate.findings) {
        if (finding.severity === 'high' || finding.severity === 'critical') {
          failures.push({
            step: gate.step || gate.file,
            issue: finding.title || finding.detail,
            suggestion: finding.suggestion || null,
          });
        }
      }
    }
  }

  // From history — gate_failed events
  for (const event of (history || [])) {
    if (event.event === 'gate_failed' && event.reason) {
      failures.push({
        step: event.step,
        issue: event.reason,
        suggestion: null,
      });
    }
  }

  return failures;
}

/**
 * Extract efficiency metrics from run state and history.
 */
function extractMetrics(runState, history, wf) {
  const metrics = {
    total_duration: null,
    step_durations: {},
    loop_counts: {},
    gate_fail_count: 0,
  };

  // Calculate durations from step_states
  for (const [stepId, state] of Object.entries(runState.step_states || {})) {
    if (state.started_at && state.completed_at) {
      const start = new Date(state.started_at).getTime();
      const end = new Date(state.completed_at).getTime();
      metrics.step_durations[stepId] = Math.round((end - start) / 1000);
    }
    if (state.loop_iteration > 0) {
      metrics.loop_counts[stepId] = state.loop_iteration;
    }
  }

  // Workflow total duration
  const created = runState.started_at ? new Date(runState.started_at).getTime() : null;
  const completed = runState.updated_at ? new Date(runState.updated_at).getTime() : null;
  if (created && completed) {
    metrics.total_duration = Math.round((completed - created) / 1000);
  }

  // Count gate failures
  metrics.gate_fail_count = (history || []).filter(e => e.event === 'gate_failed').length;

  return metrics;
}

/**
 * Build lesson entries for a single step.
 */
function buildStepLessons(step, dir, runId, failures, metrics) {
  const content = readArtifact(dir, runId, step);

  // Extract insights from artifact content if available, or from step summary as fallback
  let insights = [];
  let decisions = [];
  if (content) {
    insights = extractKeyInsights(content);
    decisions = extractDecisions(content);
  } else {
    // Fallback: try to extract from step summary (for handoff-only steps)
    const state = loadState(dir, runId);
    const stepState = state?.step_states?.[step.id] || {};
    const summary = stepState.structured_summary;
    if (summary) {
      if (summary.key_decisions) decisions = summary.key_decisions;
      if (summary.completed_actions) insights = summary.completed_actions;
    } else if (stepState.summary) {
      insights = extractKeyInsights(stepState.summary);
      decisions = extractDecisions(stepState.summary);
    }
  }

  const stepFailures = failures.filter(f =>
    String(f.step) === String(step.id) || String(f.step).includes(step.name)
  );

  const stepLessons = [];

  // Success patterns from decisions
  for (const d of decisions.slice(0, 3)) {
    stepLessons.push({ type: 'success', text: d });
  }

  // Key insights
  for (const i of insights.slice(0, 2)) {
    if (!decisions.includes(i)) {
      stepLessons.push({ type: 'insight', text: i });
    }
  }

  // Pitfalls from failures
  for (const f of stepFailures) {
    stepLessons.push({
      type: 'pitfall',
      text: f.issue,
      suggestion: f.suggestion,
    });
  }

  // Loop metrics as lessons
  const loopCount = metrics.loop_counts[step.id];
  if (loopCount && loopCount > 1) {
    stepLessons.push({
      type: 'pitfall',
      text: `此步骤经历了 ${loopCount} 次循环才通过门控`,
      suggestion: '检查步骤指令是否足够明确，或降低门控阈值',
    });
  }

  if (stepLessons.length === 0) return null;
  return { step_id: step.id, lessons: stepLessons };
}

/**
 * Build lesson entries for all steps.
 */
function buildLessons(wf, dir, runId) {
  const gateResults = readGateResults(dir, runId);
  const history = loadHistory(dir, runId);
  const runState = loadState(dir, runId);
  const failures = extractFailures(history, gateResults);
  const metrics = extractMetrics(runState, history, wf);

  const lessons = {
    workflow_name: wf.name,
    run_id: runId,
    date: todayStr(),
    metrics,
    steps: {},
  };

  for (const step of wf.steps) {
    const result = buildStepLessons(step, dir, runId, failures, metrics);
    if (result) {
      lessons.steps[step.name] = result;
    }
  }

  return lessons;
}

// ── Commands ──────────────────────────────────────────────

function extract(flags) {
  const { dir, run: runId } = flags;
  if (!dir) fail('--dir is required');

  let wf = loadWorkflow(dir);

  // Migrate to v3 if needed
  if (!wf.schema_version || wf.schema_version === '1.0') {
    wf = migrateToV3(wf, dir);
  }

  // Resolve run ID
  const runs = listRuns(dir);
  if (runs.length === 0) {
    fail('No runs found. Cannot extract lessons.');
  }
  const resolvedRunId = runId || (runs.length === 1 ? runs[0].id : null);
  if (!resolvedRunId) {
    fail(`Multiple runs found. Specify --run. Available: ${runs.map(r => r.id).join(', ')}`);
  }

  // Build lessons with run-specific state
  const lessons = buildLessons(wf, dir, resolvedRunId);

  // Ensure lessons directory
  const absDir = getAbsDir(dir);
  const lessonsDir = join(absDir, 'lessons');
  if (!existsSync(lessonsDir)) {
    mkdirSync(lessonsDir, { recursive: true });
  }

  // Generate markdown
  const md = formatLessonsMarkdown(lessons);
  const filename = `${wf.name}-${todayStr()}.md`;
  const lessonsPath = join(lessonsDir, filename);
  writeFileSync(lessonsPath, md, 'utf-8');

  // Update workflow evolution metadata
  if (!wf.evolution) {
    wf.evolution = { enabled: true, max_lessons_per_step: MAX_LESSONS_PER_STEP };
  }
  wf.evolution.last_extracted = now();
  wf.evolution.lessons_file = `lessons/${filename}`;
  writeJSON(workflowPath(dir), wf);

  const stepCount = Object.keys(lessons.steps).length;
  const totalLessons = Object.values(lessons.steps)
    .reduce((sum, s) => sum + s.lessons.length, 0);

  output({
    ok: true,
    message: `Extracted ${totalLessons} lessons from ${stepCount} steps`,
    run_id: resolvedRunId,
    lessons_file: `lessons/${filename}`,
    steps_with_lessons: stepCount,
    total_lessons: totalLessons,
    metrics: lessons.metrics,
  });
}

/**
 * Incremental single-step extraction. Extracts lessons from one completed step
 * and appends to the lessons file, then auto-injects into step instruction files.
 * This ensures experience is captured even if the user exits mid-workflow.
 */
function extractStep(flags) {
  const { dir, run: runId, step: stepId } = flags;
  if (!dir) fail('--dir is required');
  if (!stepId) fail('--step is required');

  let wf = loadWorkflow(dir);
  if (!wf.schema_version || wf.schema_version === '1.0') {
    wf = migrateToV3(wf, dir);
  }

  // Resolve run ID
  const runs = listRuns(dir);
  if (runs.length === 0) {
    fail('No runs found.');
  }
  const resolvedRunId = runId || (runs.length === 1 ? runs[0].id : null);
  if (!resolvedRunId) {
    fail(`Multiple runs found. Specify --run. Available: ${runs.map(r => r.id).join(', ')}`);
  }

  // Find the step
  const step = wf.steps.find(s => String(s.id) === String(stepId));
  if (!step) {
    fail(`Step ${stepId} not found in workflow`);
  }

  // Build lessons for this single step
  const gateResults = readGateResults(dir, resolvedRunId);
  const history = loadHistory(dir, resolvedRunId);
  const runState = loadState(dir, resolvedRunId);
  const failures = extractFailures(history, gateResults);
  const metrics = extractMetrics(runState, history, wf);

  const result = buildStepLessons(step, dir, resolvedRunId, failures, metrics);
  if (!result || result.lessons.length === 0) {
    output({
      ok: true,
      message: `No lessons to extract from step ${stepId} (${step.name})`,
      step: stepId,
      lessons_count: 0,
    });
    return;
  }

  // Ensure lessons directory
  const absDir = getAbsDir(dir);
  const lessonsDir = join(absDir, 'lessons');
  if (!existsSync(lessonsDir)) {
    mkdirSync(lessonsDir, { recursive: true });
  }

  // Append to or create lessons file
  const filename = `${wf.name}-${todayStr()}.md`;
  const lessonsPath = join(lessonsDir, filename);

  if (existsSync(lessonsPath)) {
    // Append: read existing, check for duplicate step section, append or replace
    let existing = readFileSync(lessonsPath, 'utf-8');
    const stepHeader = `## ${step.name}`;
    if (existing.includes(stepHeader)) {
      // Replace existing step section
      const stepRegex = new RegExp(
        `## ${escapeRegex(step.name)}\\n[\\s\\S]*?(?=\\n## |$)`,
      );
      const newSection = formatStepSection(step.name, result.lessons);
      existing = existing.replace(stepRegex, newSection);
    } else {
      // Append new step section
      existing = existing.trimEnd() + '\n\n' + formatStepSection(step.name, result.lessons) + '\n';
    }
    writeFileSync(lessonsPath, existing, 'utf-8');
  } else {
    // Create new lessons file with just this step
    const lines = [];
    lines.push(`# Lessons Learned: ${wf.name}`);
    lines.push(`\n> Extracted: ${todayStr()}`);
    lines.push('');
    lines.push(formatStepSection(step.name, result.lessons));
    lines.push('');
    writeFileSync(lessonsPath, lines.join('\n'), 'utf-8');
  }

  // Update evolution metadata
  if (!wf.evolution) {
    wf.evolution = { enabled: true, max_lessons_per_step: MAX_LESSONS_PER_STEP };
  }
  wf.evolution.last_extracted = now();
  wf.evolution.lessons_file = `lessons/${filename}`;
  writeJSON(workflowPath(dir), wf);

  // Auto-inject into step instruction files
  try {
    inject({ dir });
  } catch {
    // inject failure is non-blocking for incremental extraction
  }

  output({
    ok: true,
    message: `Extracted ${result.lessons.length} lessons from step ${stepId} (${step.name})`,
    step: stepId,
    step_name: step.name,
    lessons_count: result.lessons.length,
    lessons_file: `lessons/${filename}`,
    auto_injected: true,
  });
}

function inject(flags) {
  const { dir, target } = flags;
  if (!dir) fail('--dir is required');

  let wf = loadWorkflow(dir);

  // Migrate to v3 if needed
  if (!wf.schema_version || wf.schema_version === '1.0') {
    wf = migrateToV3(wf, dir);
  }

  const targetDir = target || dir;
  const targetWf = target ? loadWorkflow(target) : wf;

  // Load latest lessons
  const absDir = getAbsDir(dir);
  const lessonsDir = join(absDir, 'lessons');

  if (!existsSync(lessonsDir)) {
    fail('No lessons found. Run extract first.');
  }

  // Find latest lessons file
  const lessonsFiles = readdirSync(lessonsDir)
    .filter(f => f.endsWith('.md'))
    .sort()
    .reverse();

  if (lessonsFiles.length === 0) {
    fail('No lessons files found. Run extract first.');
  }

  const latestLessons = readFileSync(join(lessonsDir, lessonsFiles[0]), 'utf-8');
  const lessons = parseLessonsFromMarkdown(latestLessons);

  // Inject into target step instruction files
  const targetAbsDir = getAbsDir(targetDir);
  let injectedCount = 0;
  const maxPerStep = wf.evolution?.max_lessons_per_step || MAX_LESSONS_PER_STEP;

  for (const step of targetWf.steps) {
    const instructionPath = join(targetAbsDir, step.instruction);
    if (!existsSync(instructionPath)) continue;

    // Find matching lessons by step name
    const stepLessons = lessons[step.name];
    if (!stepLessons || stepLessons.length === 0) continue;

    let content = readFileSync(instructionPath, 'utf-8');

    // Build evolve block
    const evolveBlock = buildEvolveBlock(content, stepLessons, maxPerStep, wf.name);

    // Security scan before injection
    const scanResult = scanContent(evolveBlock);
    if (!scanResult.safe) {
      // High-risk content detected, skip this step
      console.error(`[SECURITY] Blocked injection for ${step.name}: ${formatScanResult(scanResult)}`);
      continue;
    }
    if (scanResult.warnings.length > 0) {
      // Medium-risk content, warn but continue
      console.warn(`[SECURITY] Warning for ${step.name}: ${formatScanResult(scanResult)}`);
    }

    // Replace or append evolve block
    if (content.includes(EVOLVE_START)) {
      const regex = new RegExp(
        `${escapeRegex(EVOLVE_START)}[\\s\\S]*?${escapeRegex(EVOLVE_END)}`,
        'g'
      );
      content = content.replace(regex, evolveBlock);
    } else {
      content = content.trimEnd() + '\n\n' + evolveBlock + '\n';
    }

    writeFileSync(instructionPath, content, 'utf-8');
    injectedCount++;
  }

  // Update evolution metadata
  if (!wf.evolution) wf.evolution = {};
  wf.evolution.last_injected = now();
  wf.evolution.inject_target = targetDir;
  writeJSON(workflowPath(dir), wf);

  output({
    ok: true,
    message: `Injected lessons into ${injectedCount} step files`,
    injected_steps: injectedCount,
    target: targetDir,
    source_file: lessonsFiles[0],
  });
}

function evolveStatus(flags) {
  const { dir } = flags;
  if (!dir) fail('--dir is required');

  let wf = loadWorkflow(dir);

  // Migrate to v3 if needed
  if (!wf.schema_version || wf.schema_version === '1.0') {
    wf = migrateToV3(wf, dir);
  }

  const absDir = getAbsDir(dir);
  const lessonsDir = join(absDir, 'lessons');

  const lessonsFiles = existsSync(lessonsDir)
    ? readdirSync(lessonsDir).filter(f => f.endsWith('.md'))
    : [];

  // Count evolve blocks in step files
  let stepsWithLessons = 0;
  for (const step of wf.steps) {
    const instructionPath = join(absDir, step.instruction);
    if (existsSync(instructionPath)) {
      const content = readFileSync(instructionPath, 'utf-8');
      if (content.includes(EVOLVE_START)) stepsWithLessons++;
    }
  }

  // Archive info
  const archivesDir = join(absDir, 'archives');
  const archiveRuns = existsSync(archivesDir)
    ? readdirSync(archivesDir).filter(d => /^run-\d+/.test(d)).sort()
    : [];

  // Run info (v3)
  const runs = listRuns(dir);

  output({
    ok: true,
    workflow: wf.name,
    runs_count: runs.length,
    runs: runs.map(r => ({ id: r.id, status: r.status })),
    evolution: wf.evolution || { enabled: false },
    lessons_files: lessonsFiles.length,
    lessons_list: lessonsFiles,
    steps_with_lessons: stepsWithLessons,
    total_steps: wf.steps.length,
    archives: archiveRuns.length,
    archive_list: archiveRuns,
  });
}

// ── Formatting ───────────────────────────────────────────

function formatLessonsMarkdown(lessons) {
  const lines = [];
  lines.push(`# Lessons Learned: ${lessons.workflow_name}`);
  lines.push(`\n> Extracted: ${lessons.date}`);
  lines.push('');

  // Metrics
  if (lessons.metrics.total_duration) {
    lines.push('## Metrics');
    lines.push(`- Total duration: ${formatDuration(lessons.metrics.total_duration)}`);
    if (lessons.metrics.gate_fail_count > 0) {
      lines.push(`- Gate failures: ${lessons.metrics.gate_fail_count}`);
    }
    for (const [stepId, loops] of Object.entries(lessons.metrics.loop_counts)) {
      lines.push(`- Step ${stepId} loop iterations: ${loops}`);
    }
    lines.push('');
  }

  // Per-step lessons
  for (const [stepName, data] of Object.entries(lessons.steps)) {
    lines.push(`## ${stepName}`);
    lines.push('');
    for (const lesson of data.lessons) {
      const prefix = lesson.type === 'success' ? '**成功模式**'
        : lesson.type === 'pitfall' ? '**踩坑记录**'
        : '**关键洞察**';
      lines.push(`- ${prefix}: ${lesson.text}`);
      if (lesson.suggestion) {
        lines.push(`  - 建议: ${lesson.suggestion}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

function formatStepSection(stepName, lessons) {
  const lines = [];
  lines.push(`## ${stepName}`);
  lines.push('');
  for (const lesson of lessons) {
    const prefix = lesson.type === 'success' ? '**成功模式**'
      : lesson.type === 'pitfall' ? '**踩坑记录**'
      : '**关键洞察**';
    lines.push(`- ${prefix}: ${lesson.text}`);
    if (lesson.suggestion) {
      lines.push(`  - 建议: ${lesson.suggestion}`);
    }
  }
  return lines.join('\n');
}

function formatDuration(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h ${Math.round((seconds % 3600) / 60)}m`;
}

function parseLessonsFromMarkdown(md) {
  const lessons = {};
  let currentStep = null;

  for (const line of md.split('\n')) {
    // Step header
    const stepMatch = line.match(/^## (\S+)/);
    if (stepMatch && stepMatch[1] !== 'Metrics') {
      currentStep = stepMatch[1];
      lessons[currentStep] = [];
      continue;
    }

    // Lesson entry
    if (currentStep && line.startsWith('- **')) {
      const typeMatch = line.match(/- \*\*(成功模式|踩坑记录|关键洞察)\*\*:\s*(.+)/);
      if (typeMatch) {
        const type = typeMatch[1] === '成功模式' ? 'success'
          : typeMatch[1] === '踩坑记录' ? 'pitfall'
          : 'insight';
        lessons[currentStep].push({ type, text: typeMatch[2] });
      }
    }
  }

  return lessons;
}

function buildEvolveBlock(existingContent, newLessons, maxPerStep, workflowName) {
  // Parse existing lessons from evolve block
  const existingLessons = [];
  if (existingContent.includes(EVOLVE_START)) {
    const match = existingContent.match(
      new RegExp(`${escapeRegex(EVOLVE_START)}([\\s\\S]*?)${escapeRegex(EVOLVE_END)}`)
    );
    if (match) {
      const block = match[1];
      for (const line of block.split('\n')) {
        const entryMatch = line.match(/- \*\*(成功模式|踩坑记录|关键洞察)\*\*:\s*(.+)/);
        if (entryMatch) {
          existingLessons.push({
            type: entryMatch[1] === '成功模式' ? 'success'
              : entryMatch[1] === '踩坑记录' ? 'pitfall'
              : 'insight',
            text: entryMatch[2],
          });
        }
      }
    }
  }

  // Merge: new lessons first, then existing, capped at max
  const allLessons = [...newLessons, ...existingLessons];
  // Deduplicate by text
  const seen = new Set();
  const unique = allLessons.filter(l => {
    if (seen.has(l.text)) return false;
    seen.add(l.text);
    return true;
  });
  const capped = unique.slice(0, maxPerStep);

  // Build block
  const lines = [EVOLVE_START];
  lines.push('## 历史经验');
  lines.push('');
  lines.push(`> From: ${workflowName} (${todayStr()})`);
  lines.push('');
  for (const lesson of capped) {
    const prefix = lesson.type === 'success' ? '**成功模式**'
      : lesson.type === 'pitfall' ? '**踩坑记录**'
      : '**关键洞察**';
    lines.push(`- ${prefix}: ${lesson.text}`);
  }
  lines.push(EVOLVE_END);

  return lines.join('\n');
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Archive ──────────────────────────────────────────────

/**
 * Determine the next archive run number.
 */
function nextRunNumber(absDir) {
  const archivesDir = join(absDir, 'archives');
  if (!existsSync(archivesDir)) return 1;

  const existing = readdirSync(archivesDir)
    .filter(d => /^run-\d+/.test(d))
    .map(d => {
      const m = d.match(/^run-(\d+)/);
      return m ? parseInt(m[1], 10) : NaN;
    })
    .filter(n => !isNaN(n));

  return existing.length > 0 ? Math.max(...existing) + 1 : 1;
}

/**
 * Sanitize summary string for use as directory name segment.
 * Keeps letters, digits, hyphens, underscores; replaces spaces with hyphens.
 */
function sanitizeSummary(summary) {
  return summary
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\w\u4e00-\u9fff-]/g, '')  // keep word chars, CJK, hyphens
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

/**
 * Archive current run's artifacts/gates/lessons/memory into archives/run-{N},
 * then reset workflow.json state for reuse.
 *
 * Preserves: steps/ (with evolved lessons), workflow.json structure
 * Archives:  artifacts/, gates/, lessons/, memory/ → archives/run-{N}/
 * Resets:    workflow.json state back to "ready"
 */
function archive(flags) {
  const { dir, summary } = flags;
  if (!dir) fail('--dir is required');
  if (!summary) fail('--summary is required (brief description of what this run accomplished)');

  const wf = loadWorkflow(dir);
  const absDir = getAbsDir(dir);

  // Determine run number and build dir name: run-{N}-{summary}
  const runNum = nextRunNumber(absDir);
  const slug = sanitizeSummary(summary);
  const runDirName = `run-${runNum}-${slug}`;
  const runDir = join(absDir, 'archives', runDirName);
  mkdirSync(runDir, { recursive: true });

  // Dirs to archive: copy then remove contents
  const dirsToArchive = ['artifacts', 'gates', 'lessons', 'memory'];
  const archived = [];

  for (const name of dirsToArchive) {
    const src = join(absDir, name);
    if (!existsSync(src)) continue;

    // Check if dir has any content
    const entries = readdirSync(src);
    if (entries.length === 0) continue;

    // Copy to archive
    const dest = join(runDir, name);
    cpSync(src, dest, { recursive: true });

    // Remove and recreate empty
    rmSync(src, { recursive: true, force: true });
    mkdirSync(src, { recursive: true });

    archived.push(name);
  }

  // Save workflow.json snapshot in archive
  writeFileSync(
    join(runDir, 'workflow-snapshot.json'),
    JSON.stringify(wf, null, 2),
    'utf-8'
  );

  // Track archive in evolution metadata
  if (!wf.evolution) wf.evolution = {};
  if (!wf.evolution.archives) wf.evolution.archives = [];
  wf.evolution.archives.push({
    run: runNum,
    summary,
    archived_at: now(),
    dir: `archives/${runDirName}`,
  });
  wf.evolution.total_runs = runNum;

  writeJSON(workflowPath(dir), wf);

  output({
    ok: true,
    message: `Run ${runNum} archived to archives/${runDirName}`,
    run: runNum,
    summary,
    archived_dirs: archived,
    archive_path: `archives/${runDirName}`,
    workflow_status: 'ready',
  });
}

// ── Main ──────────────────────────────────────────────────

const { command, flags } = parseArgs(process.argv.slice(2));

switch (command) {
  case 'extract':      extract(flags); break;
  case 'extract-step': extractStep(flags); break;
  case 'inject':       inject(flags); break;
  case 'archive':      archive(flags); break;
  case 'status':       evolveStatus(flags); break;
  default:             fail(`Unknown command: ${command}. Use extract|extract-step|inject|archive|status`);
}
