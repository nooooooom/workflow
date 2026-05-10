/**
 * Workflow Engine — Loop Guard
 *
 * Controls retry loops with iteration counting and convergence detection.
 * Supports exponential backoff for retry timing.
 *
 * Commands:
 *   check    --dir <path> --run <id> --step <id>   Can this step loop again?
 *   iterate  --dir <path> --run <id> --step <id>   Increment loop counter, check convergence
 *   reset    --dir <path> --run <id> --step <id>   Reset loop counter
 *   backoff  --dir <path> --run <id> --step <id>   Get exponential backoff wait time
 */

import {
  readJSON, writeJSON, workflowPath, getWorkflowRoot,
  now, parseArgs, output, fail, fingerprint,
  getStatePath, getHistoryPath, listRuns,
} from './utils.mjs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

// ── Exponential Backoff ───────────────────────────────────

/**
 * Calculate exponential backoff wait time.
 * Formula: baseDelay * (2 ^ iteration) + jitter
 * Capped at maxDelay.
 *
 * @param {number} iteration - Current iteration (0-based)
 * @param {object} options - Backoff options
 * @param {number} options.baseDelay - Base delay in ms (default: 1000)
 * @param {number} options.maxDelay - Maximum delay in ms (default: 30000)
 * @param {number} options.multiplier - Exponential multiplier (default: 2)
 * @param {boolean} options.jitter - Add random jitter (default: true)
 * @returns {number} Wait time in milliseconds
 */
function calculateBackoff(iteration, options = {}) {
  const {
    baseDelay = 1000,
    maxDelay = 30000,
    multiplier = 2,
    jitter = true,
  } = options;

  // Exponential calculation with cap
  const exponentialDelay = Math.min(
    baseDelay * Math.pow(multiplier, iteration),
    maxDelay
  );

  // Add jitter (±20%) to prevent thundering herd
  if (jitter) {
    const jitterRange = exponentialDelay * 0.2;
    const jitterValue = (Math.random() * 2 - 1) * jitterRange;
    return Math.round(exponentialDelay + jitterValue);
  }

  return Math.round(exponentialDelay);
}

// ── Helpers ───────────────────────────────────────────────

function loadWorkflow(dir) {
  if (!dir) fail('Workflow directory is required');
  const wf = readJSON(workflowPath(dir));
  if (!wf) fail(`No workflow found at ${dir}`);
  return wf;
}

function loadState(dir, runId) {
  if (!runId) fail('--run is required. Use session list-runs to see available runs.');
  const state = readJSON(getStatePath(dir, runId));
  if (!state) fail(`Run "${runId}" not found`);
  return state;
}

function saveState(dir, runId, state) {
  state.updated_at = now();
  writeJSON(getStatePath(dir, runId), state);
}

function loadHistory(dir, runId) {
  return readJSON(getHistoryPath(dir, runId)) || [];
}

function saveHistory(dir, runId, history) {
  writeJSON(getHistoryPath(dir, runId), history);
}

function getStep(wf, stepId) {
  const id = Number(stepId);
  return wf.steps.find(s => s.id === id);
}

/**
 * Calculate overlap ratio between two fingerprint arrays.
 * @returns {number} 0.0 to 1.0
 */
function fingerprintOverlap(prev, curr) {
  if (!prev || !curr || prev.length === 0 || curr.length === 0) return 0;
  const prevSet = new Set(prev);
  const matches = curr.filter(f => prevSet.has(f)).length;
  return matches / Math.max(prev.length, curr.length);
}

function emitHook(dir, runId, event, data) {
  if (!dir) {
    console.error('[Hook Error] dir parameter is required');
    return;
  }
  const wfRoot = getWorkflowRoot(dir);
  // Get project root (parent of .workflows)
  const projectRoot = join(wfRoot, '..', '..');
  try {
    execSync(`node engine/hooks.mjs emit --dir "${dir}" --run "${runId}" --event ${event} --data '${JSON.stringify(data)}'`, {
      cwd: projectRoot,
      encoding: 'utf-8',
      timeout: 10000,
    });
  } catch (e) {
    console.error(`[Hook Error] ${event}:`, e.message);
  }
}

// ── Commands ──────────────────────────────────────────────

function check(flags) {
  const { dir, run: runId, step: stepId } = flags;
  if (!dir) fail('--dir is required');
  if (!stepId) fail('--step is required');

  const wf = loadWorkflow(dir);
  const step = getStep(wf, stepId);
  if (!step) fail(`Step ${stepId} not found`);

  const runState = loadState(dir, runId);
  const stepState = runState.step_states[step.id] || {};
  const iteration = stepState.loop_iteration || 0;
  const maxIterations = step.loop.max_iterations || 3;
  const enabled = step.loop.enabled;

  if (!enabled) {
    output({
      ok: true,
      can_continue: false,
      reason: 'loop_disabled',
      iteration,
      max_iterations: maxIterations,
      run_id: runId,
    });
    return;
  }

  if (iteration >= maxIterations) {
    output({
      ok: true,
      can_continue: false,
      reason: 'max_iterations_reached',
      iteration,
      max_iterations: maxIterations,
      run_id: runId,
    });
    return;
  }

  output({
    ok: true,
    can_continue: true,
    iteration,
    max_iterations: maxIterations,
    remaining: maxIterations - iteration,
    run_id: runId,
  });
}

function iterate(flags) {
  const { dir, run: runId, step: stepId } = flags;
  if (!dir) fail('--dir is required');
  if (!stepId) fail('--step is required');

  const wf = loadWorkflow(dir);
  const step = getStep(wf, stepId);
  if (!step) fail(`Step ${stepId} not found`);

  const runState = loadState(dir, runId);
  const stepState = runState.step_states[step.id] || {};
  const prevIteration = stepState.loop_iteration || 0;
  const maxIterations = step.loop.max_iterations || 3;

  if (!step.loop.enabled) {
    fail('Loop is not enabled for this step');
  }

  if (prevIteration >= maxIterations) {
    output({
      ok: false,
      escalate: true,
      reason: 'max_iterations_reached',
      iteration: prevIteration,
      max_iterations: maxIterations,
      run_id: runId,
    });
    return;
  }

  // Emit on_loop_start hook before first iteration
  if (prevIteration === 0) {
    emitHook(dir, runId, 'on_loop_start', { step: step.id, name: step.name, max_iterations: maxIterations });
  }

  // Increment counter
  const newIteration = prevIteration + 1;
  stepState.loop_iteration = newIteration;

  // Convergence detection: compare current vs previous finding fingerprints
  const prevFingerprints = stepState.prev_findings_fingerprints || null;
  const currFingerprints = stepState.last_findings_fingerprints || null;
  const overlap = fingerprintOverlap(prevFingerprints, currFingerprints);
  const isStuck = overlap > 0.8 && prevIteration > 0;

  // Shift fingerprints for next iteration
  stepState.prev_findings_fingerprints = currFingerprints;
  stepState.last_findings_fingerprints = null;

  // Reset step status to allow re-execution
  stepState.status = 'gate_failed'; // advance.mjs start accepts gate_failed

  // Ensure step_states entry is written back
  runState.step_states[step.id] = stepState;

  const history = loadHistory(dir, runId);
  history.push({
    event: 'loop_iterate',
    step: step.id,
    iteration: newIteration,
    convergence_overlap: overlap,
    is_stuck: isStuck,
    at: now(),
  });
  saveHistory(dir, runId, history);

  saveState(dir, runId, runState);

  if (isStuck) {
    // Emit on_loop_exit hook
    emitHook(dir, runId, 'on_loop_exit', { step: step.id, name: step.name, reason: 'convergence_detected', iteration: newIteration });

    const backoffMs = calculateBackoff(newIteration, step.loop?.backoff || {});
    output({
      ok: true,
      escalate: true,
      reason: 'convergence_detected',
      message: `Findings overlap ${(overlap * 100).toFixed(0)}% with previous iteration. Same issues repeating.`,
      iteration: newIteration,
      max_iterations: maxIterations,
      overlap,
      suggested_backoff_ms: backoffMs,
      run_id: runId,
    });
  } else if (newIteration >= maxIterations) {
    // Emit on_loop_exit hook
    emitHook(dir, runId, 'on_loop_exit', { step: step.id, name: step.name, reason: 'max_iterations_reached', iteration: newIteration });

    output({
      ok: true,
      escalate: true,
      reason: 'max_iterations_reached',
      iteration: newIteration,
      max_iterations: maxIterations,
      run_id: runId,
    });
  } else {
    const backoffMs = calculateBackoff(newIteration, step.loop?.backoff || {});
    output({
      ok: true,
      escalate: false,
      iteration: newIteration,
      max_iterations: maxIterations,
      remaining: maxIterations - newIteration,
      overlap,
      suggested_backoff_ms: backoffMs,
      message: `Iteration ${newIteration}/${maxIterations}. Re-execute step with gate findings as context.`,
      run_id: runId,
    });
  }
}

function reset(flags) {
  const { dir, run: runId, step: stepId } = flags;
  if (!dir) fail('--dir is required');
  if (!stepId) fail('--step is required');

  const wf = loadWorkflow(dir);
  const step = getStep(wf, stepId);
  if (!step) fail(`Step ${stepId} not found`);

  const runState = loadState(dir, runId);
  const stepState = runState.step_states[step.id] || {};
  stepState.loop_iteration = 0;
  stepState.prev_findings_fingerprints = null;
  stepState.last_findings_fingerprints = null;

  // Ensure step_states entry is written back
  runState.step_states[step.id] = stepState;

  const history = loadHistory(dir, runId);
  history.push({ event: 'loop_reset', step: step.id, at: now() });
  saveHistory(dir, runId, history);

  saveState(dir, runId, runState);
  output({ ok: true, step: step.id, message: 'Loop counter reset to 0', run_id: runId });
}

function backoff(flags) {
  const { dir, run: runId, step: stepId, iteration: iterationFlag } = flags;
  if (!dir) fail('--dir is required');
  if (!stepId) fail('--step is required');

  const wf = loadWorkflow(dir);
  const step = getStep(wf, stepId);
  if (!step) fail(`Step ${stepId} not found`);

  const runState = loadState(dir, runId);
  const stepState = runState.step_states[step.id] || {};
  // Use --iteration flag if provided, otherwise fall back to state
  const iteration = iterationFlag !== undefined ? parseInt(iterationFlag, 10) : (stepState.loop_iteration || 0);

  // Get backoff configuration from step or use defaults
  const backoffConfig = step.loop?.backoff || {};
  const waitTime = calculateBackoff(iteration, {
    baseDelay: backoffConfig.baseDelay || 1000,
    maxDelay: backoffConfig.maxDelay || 30000,
    multiplier: backoffConfig.multiplier || 2,
    jitter: backoffConfig.jitter !== false,
  });

  const humanReadable = waitTime >= 1000
    ? `${(waitTime / 1000).toFixed(1)}s`
    : `${waitTime}ms`;

  output({
    ok: true,
    step: step.id,
    iteration,
    wait_ms: waitTime,
    wait_human: humanReadable,
    backoff_config: {
      baseDelay: backoffConfig.baseDelay || 1000,
      maxDelay: backoffConfig.maxDelay || 30000,
      multiplier: backoffConfig.multiplier || 2,
      jitter: backoffConfig.jitter !== false,
    },
    message: `Wait ${humanReadable} before retry (iteration ${iteration})`,
    run_id: runId,
  });
}

// ── Main ──────────────────────────────────────────────────

const { command, flags } = parseArgs(process.argv.slice(2));

switch (command) {
  case 'check':   check(flags); break;
  case 'iterate': iterate(flags); break;
  case 'reset':   reset(flags); break;
  case 'backoff': backoff(flags); break;
  default:        fail(`Unknown command: ${command}. Use check|iterate|reset|backoff`);
}
