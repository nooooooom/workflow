/**
 * Workflow Engine — Session Manager
 *
 * CRUD operations for workflow.json (the single source of truth).
 *
 * Commands:
 *   init      --dir <path> --name <name> --steps <json>  Create new workflow
 *   run       --dir <path> [--summary <text>]            Create a new run instance
 *   list-runs --dir <path>                               List all run instances
 *   get       --dir <path> [--field <dotpath>]           Read workflow or field
 *   update    --dir <path> --set <dotpath=value>         Update a field
 *   list      [--base <path>] [--compact]                 List all workflows
 *   match     --query <text> [--base <path>] [--threshold <0-1>]  Smart match workflows
 */

import {
  readJSON, writeJSON, deepGet, deepSet,
  resolveWorkflowDir, workflowPath, ensureDir,
  now, parseArgs, output, fail, listWorkflows,
  generateRunId, migrateToV3, ensureRunDir, listRuns,
  getStatePath, getHistoryPath, detectSchema,
} from './utils.mjs';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

// ── Commands ──────────────────────────────────────────────

function init(flags) {
  const { dir, name, steps: stepsRaw, description } = flags;
  if (!dir) fail('--dir is required');
  if (!name) fail('--name is required');
  if (!stepsRaw) fail('--steps is required (JSON array)');

  const absDir = resolveWorkflowDir(dir);
  const wfPath = workflowPath(dir);

  if (existsSync(wfPath)) {
    fail(`Workflow already exists at ${dir}. Use 'get' or 'update'.`);
  }

  let steps;
  try {
    steps = JSON.parse(stepsRaw);
  } catch {
    fail('--steps must be valid JSON array');
  }

  if (!Array.isArray(steps) || steps.length === 0) {
    fail('--steps must be a non-empty array');
  }

  // Normalize steps: ensure each has required fields
  const normalizedSteps = steps.map((s, i) => ({
    id: s.id || i + 1,
    name: s.name || `step-${i + 1}`,
    instruction: s.instruction || `steps/${String(i + 1).padStart(2, '0')}-${s.name || 'step'}.md`,
    artifact: s.artifact === null ? null : (s.artifact || `artifacts/${String(i + 1).padStart(2, '0')}-${s.name || 'step'}.md`),
    provider: s.provider || null,
    dependsOn: s.dependsOn || [],
    gate: {
      enabled: s.gate?.enabled ?? true,
      type: s.gate?.type || 'review',
      command: s.gate?.command || null,
      tool: s.gate?.tool || null,
      high_threshold: s.gate?.high_threshold ?? 3,
      ...(s.gate?.criteria ? { criteria: s.gate.criteria } : {}),
    },
    loop: {
      enabled: s.loop?.enabled ?? false,
      max_iterations: s.loop?.max_iterations ?? 3,
      backoff: {
        baseDelay: s.loop?.backoff?.baseDelay || 1000,
        maxDelay: s.loop?.backoff?.maxDelay || 30000,
        multiplier: s.loop?.backoff?.multiplier || 2,
        jitter: s.loop?.backoff?.jitter !== false,
      },
    },
  }));

  // v3 schema: workflow.json only contains static config
  const workflow = {
    name,
    description: description || '',
    created_at: now(),
    steps: normalizedSteps,
    hooks: {
      on_step_start: [],
      on_step_complete: [],
      on_gate_pass: [],
      on_gate_fail: [],
      on_workflow_complete: [],
      on_loop_start: [],
      on_loop_exit: [],
    },
    message_bus: {
      messages: [],
      agents: {},
    },
    evolution: {
      enabled: true,
      max_lessons_per_step: 5,
      last_extracted: null,
      lessons_file: null,
      last_injected: null,
    },
  };

  // Create directory structure
  ensureDir(absDir);
  ensureDir(join(absDir, 'steps'));
  ensureDir(join(absDir, 'runs'));
  ensureDir(join(absDir, 'memory'));

  writeJSON(wfPath, workflow);

  output({
    ok: true,
    dir,
    name,
    steps: normalizedSteps.length,
    first_step: normalizedSteps[0],
    schema: 'v3',
  });
}

function get(flags) {
  const { dir, field } = flags;
  if (!dir) fail('--dir is required');

  const wf = readJSON(workflowPath(dir));
  if (!wf) fail(`No workflow found at ${dir}`);

  if (field) {
    const value = deepGet(wf, field);
    output({ field, value });
  } else {
    output(wf);
  }
}

function update(flags) {
  const { dir, set: setExpr } = flags;
  if (!dir) fail('--dir is required');
  if (!setExpr) fail('--set is required (e.g. state.status=completed)');

  const wfPath_ = workflowPath(dir);
  const wf = readJSON(wfPath_);
  if (!wf) fail(`No workflow found at ${dir}`);

  // Parse "dotpath=value"
  const eqIdx = setExpr.indexOf('=');
  if (eqIdx === -1) fail('--set must be in format "path=value"');

  const path = setExpr.slice(0, eqIdx);
  let value = setExpr.slice(eqIdx + 1);

  // Try to parse as JSON (for numbers, booleans, arrays, objects)
  try {
    value = JSON.parse(value);
  } catch {
    // Keep as string
  }

  deepSet(wf, path, value);

  writeJSON(wfPath_, wf);
  output({ ok: true, path, value });
}

function list(flags) {
  const base = flags.base || '.workflows';
  const compact = flags.compact;
  const workflows = listWorkflows(base);

  if (compact) {
    if (workflows.length === 0) {
      console.log('(no workflows found)');
    } else {
      for (const wf of workflows) {
        const desc = wf.description.length > 60
          ? wf.description.slice(0, 57) + '...'
          : wf.description;
        console.log(`${wf.name}: ${desc}`);
      }
    }
    return;
  }

  output({ workflows });
}

/**
 * List all run instances for a workflow.
 */
function listRunsCmd(flags) {
  const { dir } = flags;
  if (!dir) fail('--dir is required');

  const wfPath = workflowPath(dir);
  if (!existsSync(wfPath)) fail(`No workflow found at ${dir}`);

  const runs = listRuns(dir);

  output({
    ok: true,
    runs,
    count: runs.length,
  });
}

/**
 * Create a new run instance for a workflow.
 * v3 schema: creates runs/{run-id}/state.json and history.json
 */
function run(flags) {
  const { dir, summary } = flags;
  if (!dir) fail('--dir is required');

  const wfPath = workflowPath(dir);
  let wf = readJSON(wfPath);
  if (!wf) fail(`No workflow found at ${dir}`);

  // Migrate to v3 if needed
  const schema = detectSchema(wf);
  if (schema !== 'v3') {
    wf = migrateToV3(wf, dir);
  }

  // Generate new run ID
  const runId = generateRunId(summary || '');
  const runSummary = summary || '';

  // Create run directory structure
  ensureRunDir(dir, runId);

  // Create state.json
  const statePath = getStatePath(dir, runId);
  const initialState = {
    id: runId,
    summary: runSummary,
    status: 'ready',
    current_step: wf.steps[0]?.id || 1,
    completed_steps: [],
    step_states: {},
    started_at: now(),
    completed_at: null,
    updated_at: now(),
  };

  for (const step of wf.steps) {
    initialState.step_states[step.id] = { status: 'pending' };
  }

  writeJSON(statePath, initialState);

  // Create history.json
  const historyPath = getHistoryPath(dir, runId);
  writeJSON(historyPath, [
    { event: 'run_created', at: now(), summary: runSummary },
  ]);

  output({
    ok: true,
    run_id: runId,
    run_dir: `runs/${runId}`,
    summary: runSummary,
    status: 'ready',
    message: `Created new run "${runId}". Ready to start workflow.`,
  });
}

// ── Match ─────────────────────────────────────────────────

/**
 * Calculate match score between query and workflow.
 * @param {string} query - User input
 * @param {object} workflow - Workflow object with name and description
 * @returns {number} Score from 0 to 1
 */
function calculateMatchScore(query, workflow) {
  const q = query.toLowerCase();
  const name = workflow.name.toLowerCase();
  const desc = (workflow.description || '').toLowerCase();

  // 1. Exact name match → 1.0
  if (q === name) return 1.0;

  // 2. Name contains query → 0.8
  if (name.includes(q)) return 0.8;

  // 3. Query contains name → 0.7 (user might type "run workflow-evolution")
  if (q.includes(name)) return 0.7;

  // 4. Description contains query → 0.5
  if (desc.includes(q)) return 0.5;

  // 5. Any word from query found in name or description → 0.3
  const words = q.split(/[\s,，、]+/).filter(w => w.length > 1);
  for (const word of words) {
    if (name.includes(word) || desc.includes(word)) return 0.3;
  }

  return 0;
}

/**
 * Match workflows by query string.
 */
function match(flags) {
  const { query, base, threshold: thresholdStr } = flags;
  if (!query) fail('--query is required');

  const basePath = base || '.workflows';
  const threshold = thresholdStr ? parseFloat(thresholdStr) : 0.3;
  const workflows = listWorkflows(basePath);

  const results = workflows
    .map(wf => ({
      ...wf,
      score: calculateMatchScore(query, wf),
    }))
    .filter(wf => wf.score >= threshold)
    .sort((a, b) => b.score - a.score);

  // Exact match: score === 1.0
  const exact = results.find(r => r.score === 1.0) || null;

  output({
    ok: true,
    query,
    exact,
    candidates: results.slice(0, 5),
    threshold,
  });
}

// ── Main ──────────────────────────────────────────────────

const { command, flags } = parseArgs(process.argv.slice(2));

switch (command) {
  case 'init':      init(flags); break;
  case 'get':       get(flags); break;
  case 'update':    update(flags); break;
  case 'list':      list(flags); break;
  case 'run':       run(flags); break;
  case 'list-runs': listRunsCmd(flags); break;
  case 'match':     match(flags); break;
  default:          fail(`Unknown command: ${command}. Use init|get|update|list|run|list-runs|match`);
}