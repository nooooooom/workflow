/**
 * Workflow Engine — State Machine
 *
 * Manages step transitions with deterministic state logic.
 * Supports dependency DAG for parallel step execution.
 *
 * Commands:
 *   start    --dir <path> --run <run-id> --step <id>  Mark step in_progress
 *   complete --dir <path> --run <run-id> --step <id>  Mark step gate_pending → run gate
 *   fail     --dir <path> --run <run-id> --step <id> --reason <msg>  Mark step failed
 *   next     --dir <path> --run <run-id>              Get next step(s) - supports DAG
 *   ready    --dir <path> --run <run-id>              Get all steps ready to run (DAG-aware)
 *   status   --dir <path> [--run <run-id>]            Get current workflow status
 *
 * State machine per step:
 *   pending → in_progress → gate_pending → completed
 *                                       ↘ gate_failed → (loop or escalate)
 *
 * Dependency DAG:
 *   Steps can have `dependsOn: [1, 2]` to depend on other steps.
 *   A step is "ready" when all dependencies are completed.
 */

import {
  readJSON, writeJSON, workflowPath, getWorkflowRoot,
  now, parseArgs, output, fail,
  ensureRunDir, migrateToV3, listRuns,
  getStatePath, getHistoryPath, detectSchema,
  resolveArtifact,
} from './utils.mjs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

// ── Dependency DAG Helpers ─────────────────────────────────

/**
 * Check if all dependencies of a step are completed.
 * @param {object} state - Run state object
 * @param {object} step - Step to check
 * @returns {boolean}
 */
function areDependenciesMet(state, step) {
  const dependsOn = step.dependsOn || [];
  if (dependsOn.length === 0) return true;

  return dependsOn.every(depId => {
    const depState = state.step_states[depId];
    return depState?.status === 'completed';
  });
}

/**
 * Get all steps that are ready to run (pending + dependencies met).
 * @param {object} wf - Workflow object
 * @param {object} state - Run state object
 * @returns {Array} Array of ready steps
 */
function getReadySteps(wf, state) {
  return wf.steps.filter(step => {
    const stepState = state.step_states[step.id];
    const isPending = !stepState || stepState.status === 'pending' || stepState.status === 'gate_failed';
    const depsMet = areDependenciesMet(state, step);
    return isPending && depsMet;
  });
}

/**
 * Get steps that are blocked by incomplete dependencies.
 * @param {object} wf - Workflow object
 * @param {object} state - Run state object
 * @returns {Array} Array of { step, blockedBy } objects
 */
function getBlockedSteps(wf, state) {
  return wf.steps
    .filter(step => {
      const stepState = state.step_states[step.id];
      const isPending = !stepState || stepState.status === 'pending';
      return isPending && !areDependenciesMet(state, step);
    })
    .map(step => ({
      step,
      blockedBy: (step.dependsOn || []).filter(depId => {
        const depState = state.step_states[depId];
        return depState?.status !== 'completed';
      }),
    }));
}

// ── Helpers ───────────────────────────────────────────────

function loadWorkflow(dir) {
  if (!dir) fail('Workflow directory is required');
  const workflowFilePath = workflowPath(dir);
  const wf = readJSON(workflowFilePath);
  if (!wf) fail(`No workflow found at ${dir}`);
  return wf;
}

function loadState(dir, runId) {
  if (!runId) fail('--run is required. Use session list-runs to see available runs.');
  const statePath = getStatePath(dir, runId);
  const state = readJSON(statePath);
  if (!state) fail(`Run "${runId}" not found`);
  return state;
}

function saveState(dir, runId, state) {
  state.updated_at = now();
  writeJSON(getStatePath(dir, runId), state);
}

function loadHistory(dir, runId) {
  const historyPath = getHistoryPath(dir, runId);
  return readJSON(historyPath) || [];
}

function saveHistory(dir, runId, history) {
  writeJSON(getHistoryPath(dir, runId), history);
}

function appendHistory(dir, runId, event, data = {}) {
  const history = loadHistory(dir, runId);
  history.push({ event, at: now(), ...data });
  saveHistory(dir, runId, history);
}

function getStep(wf, stepId) {
  const id = Number(stepId);
  const step = wf.steps.find(s => s.id === id);
  if (!step) fail(`Step ${stepId} not found`);
  return step;
}

function getStepState(state, stepId) {
  const id = String(stepId);
  if (!state.step_states[id]) {
    state.step_states[id] = { status: 'pending' };
  }
  return state.step_states[id];
}

function emitHook(dir, runId, event, data) {
  if (!dir) {
    console.error('[Hook Error] dir parameter is required');
    return;
  }
  const wfRoot = getWorkflowRoot(dir);
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

function triggerEvolve(dir, projectRoot) {
  try {
    execSync(`node engine/evolve.mjs extract --dir "${dir}"`, {
      cwd: projectRoot,
      encoding: 'utf-8',
      timeout: 30000,
    });
    execSync(`node engine/evolve.mjs inject --dir "${dir}"`, {
      cwd: projectRoot,
      encoding: 'utf-8',
      timeout: 30000,
    });
  } catch (e) {
    console.error(`[Evolve Error] Failed to extract/inject lessons:`, e.message);
  }
}

function triggerStepEvolve(dir, runId, stepId, projectRoot) {
  try {
    execSync(`node engine/evolve.mjs extract-step --dir "${dir}" --run "${runId}" --step ${stepId}`, {
      cwd: projectRoot,
      encoding: 'utf-8',
      timeout: 30000,
    });
  } catch (e) {
    console.error(`[Evolve Error] Failed to extract lessons for step ${stepId}:`, e.message);
  }
}

function triggerMemoryAgent(dir, runId, stepId, projectRoot) {
  try {
    execSync(`node engine/memory-agent.mjs summarize --dir "${dir}" --run "${runId}" --step ${stepId}`, {
      cwd: projectRoot,
      encoding: 'utf-8',
      timeout: 15000,
    });
  } catch (e) {
    console.error(`[Memory Agent Error] Failed to generate summary for step ${stepId}:`, e.message);
  }
}

function triggerHandoff(dir, runId, stepId, projectRoot) {
  try {
    execSync(`node engine/handoff.mjs generate --dir "${dir}" --run "${runId}" --step ${stepId}`, {
      cwd: projectRoot,
      encoding: 'utf-8',
      timeout: 10000,
    });
  } catch (e) {
    // Handoff is non-blocking — log error but don't fail the workflow
    console.error(`[Handoff Error] Failed to generate handoff for step ${stepId}:`, e.message);
  }
}

function loadInboundHandoff(dir, runId, stepId, projectRoot) {
  try {
    const result = execSync(`node engine/handoff.mjs load --dir "${dir}" --run "${runId}" --step ${stepId}`, {
      cwd: projectRoot,
      encoding: 'utf-8',
      timeout: 5000,
    });
    return JSON.parse(result);
  } catch (e) {
    return { ok: true, handoff: null, message: 'Handoff load failed, use compact context.' };
  }
}

function generateSnapshot(dir, runId, projectRoot) {
  try {
    execSync(`node engine/context-manager.mjs snapshot --dir "${dir}" --run "${runId}"`, {
      cwd: projectRoot,
      encoding: 'utf-8',
      timeout: 5000,
    });
    return { ok: true, path: `runs/${runId}/memory/snapshot.json` };
  } catch (e) {
    return { ok: false, warning: `Snapshot generation failed: ${e.message}` };
  }
}

/**
 * Resolve run ID from flags or prompt user to select.
 * If --run is specified, use it.
 * If only one run exists, use it.
 * If multiple runs exist, return null (caller should prompt user).
 */
function resolveRunId(dir, flags, wf) {
  if (flags.run) {
    return flags.run;
  }

  const runs = listRuns(dir);

  if (runs.length === 0) {
    fail('No run instances found. Use session run to create one.');
  }

  if (runs.length === 1) {
    return runs[0].id;
  }

  // Multiple runs - return null to signal caller to prompt user
  return null;
}

// ── Commands ──────────────────────────────────────────────

function start(flags) {
  const { dir, step: stepId } = flags;
  if (!dir) fail('--dir is required');
  if (!stepId) fail('--step is required');

  let wf = loadWorkflow(dir);

  // Migrate to v3 if needed
  const schema = detectSchema(wf);
  if (schema !== 'v3') {
    wf = migrateToV3(wf, dir);
  }

  // Resolve run ID
  const runId = resolveRunId(dir, flags, wf);
  if (!runId) {
    const runs = listRuns(dir);
    output({
      ok: false,
      error: 'multiple_runs',
      message: 'Multiple run instances found. Please specify --run.',
      runs: runs.map(r => ({ id: r.id, status: r.status, summary: r.summary })),
      hint: 'Use --run <run-id> to specify which run to operate on.',
    });
    return;
  }

  const state = loadState(dir, runId);
  const step = getStep(wf, stepId);
  const stepState = getStepState(state, stepId);

  // Check dependencies
  if (!areDependenciesMet(state, step)) {
    const blockedBy = (step.dependsOn || []).filter(depId => {
      const depState = state.step_states[depId];
      return depState?.status !== 'completed';
    });
    fail(`Cannot start step ${stepId}: dependencies not met. Blocked by: ${blockedBy.join(', ')}`);
  }

  // Allow start from pending or gate_failed (retry)
  if (stepState.status !== 'pending' && stepState.status !== 'gate_failed') {
    fail(`Cannot start step ${stepId}: current status is '${stepState.status}', expected 'pending' or 'gate_failed'`);
  }

  stepState.status = 'in_progress';
  stepState.started_at = now();
  state.current_step = step.id;
  state.status = 'in_progress';

  appendHistory(dir, runId, 'step_started', { step: step.id, name: step.name });
  saveState(dir, runId, state);

  // Emit hook
  emitHook(dir, runId, 'on_step_start', { step: step.id, name: step.name });

  // Generate snapshot for stable context during step execution
  const wfRoot = getWorkflowRoot(dir);
  const projectRoot = join(wfRoot, '..', '..');
  const snapshot = generateSnapshot(dir, runId, projectRoot);

  // Load inbound handoff from previous step
  const handoffResult = loadInboundHandoff(dir, runId, stepId, projectRoot);

  // Calculate artifact path (null for handoff-only steps)
  const resolved = resolveArtifact(step.artifact, stepId);
  const artifactPath = resolved.type === 'none' ? null : `runs/${runId}/${resolved.path}`;

  output({
    ok: true,
    step: step.id,
    name: step.name,
    instruction: step.instruction,
    artifact: artifactPath,
    artifact_type: resolved.type,
    provider: step.provider,
    dependsOn: step.dependsOn || [],
    run_id: runId,
    snapshot: snapshot,
    handoff: handoffResult?.handoff || null,
  });
}

function complete(flags) {
  const { dir, step: stepId } = flags;
  if (!dir) fail('--dir is required');
  if (!stepId) fail('--step is required');

  let wf = loadWorkflow(dir);

  // Migrate to v3 if needed
  const schema = detectSchema(wf);
  if (schema !== 'v3') {
    wf = migrateToV3(wf, dir);
  }

  // Resolve run ID
  const runId = resolveRunId(dir, flags, wf);
  if (!runId) {
    const runs = listRuns(dir);
    output({
      ok: false,
      error: 'multiple_runs',
      message: 'Multiple run instances found. Please specify --run.',
      runs: runs.map(r => ({ id: r.id, status: r.status, summary: r.summary })),
      hint: 'Use --run <run-id> to specify which run to operate on.',
    });
    return;
  }

  const state = loadState(dir, runId);
  const step = getStep(wf, stepId);
  const stepState = getStepState(state, stepId);

  if (stepState.status !== 'in_progress') {
    fail(`Cannot complete step ${stepId}: status is '${stepState.status}', expected 'in_progress'`);
  }

  // Check if artifact exists (skip for null artifact / handoff-only steps)
  const wfRoot = getWorkflowRoot(dir);
  const resolved = resolveArtifact(step.artifact, stepId);
  const hasArtifact = resolved.type === 'none'
    ? false
    : existsSync(join(wfRoot, 'runs', runId, resolved.path));

  if (step.gate && step.gate.enabled) {
    // Move to gate_pending
    stepState.status = 'gate_pending';
    appendHistory(dir, runId, 'gate_pending', { step: step.id, has_artifact: hasArtifact });
    saveState(dir, runId, state);

    emitHook(dir, runId, 'on_step_complete', { step: step.id, name: step.name, artifact: step.artifact, status: 'gate_pending' });

    output({
      ok: true,
      step: step.id,
      status: 'gate_pending',
      gate: step.gate,
      has_artifact: hasArtifact,
      run_id: runId,
      message: 'Run gate evaluation, then call gate.mjs result',
    });
  } else {
    // No gate — mark completed directly
    stepState.status = 'completed';
    stepState.completed_at = now();
    stepState.gate_result = 'skip';

    if (!state.completed_steps) {
      state.completed_steps = [];
    }
    if (!state.completed_steps.includes(step.id)) {
      state.completed_steps.push(step.id);
    }

    // Find next step(s) - DAG aware
    const readySteps = getReadySteps(wf, state);
    const nextStep = readySteps[0] || null;

    if (nextStep) {
      state.current_step = nextStep.id;
    } else {
      // Check if all steps are completed
      const allCompleted = wf.steps.every(s => {
        const st = state.step_states[s.id];
        return st?.status === 'completed';
      });
      if (allCompleted) {
        state.status = 'completed';
        state.current_step = null;
        state.completed_at = now();
        appendHistory(dir, runId, 'workflow_completed');
      }
    }

    appendHistory(dir, runId, 'step_completed', { step: step.id, gate: 'skipped' });
    saveState(dir, runId, state);

    // Trigger memory-agent
    const wfRoot = getWorkflowRoot(dir);
    const projectRoot = join(wfRoot, '..', '..');
    triggerMemoryAgent(dir, runId, step.id, projectRoot);

    // Incremental evolution: extract lessons from this step immediately
    triggerStepEvolve(dir, runId, step.id, projectRoot);

    // Generate handoff for next step
    triggerHandoff(dir, runId, step.id, projectRoot);

    // Emit hooks
    emitHook(dir, runId, 'on_step_complete', { step: step.id, name: step.name, artifact: step.artifact, status: 'completed' });

    if (!nextStep && state.status === 'completed') {
      emitHook(dir, runId, 'on_workflow_complete', { workflow: wf.name });
      triggerEvolve(dir, projectRoot);
    }

    output({
      ok: true,
      step: step.id,
      status: 'completed',
      gate: 'skipped',
      next_step: nextStep || null,
      ready_steps: readySteps.length > 1 ? readySteps : undefined,
      workflow_completed: !nextStep && state.status === 'completed',
      run_id: runId,
    });
  }
}

function markFail(flags) {
  const { dir, step: stepId, reason } = flags;
  if (!dir) fail('--dir is required');
  if (!stepId) fail('--step is required');

  const wf = loadWorkflow(dir);
  const runId = resolveRunId(dir, flags, wf);
  if (!runId) {
    const runs = listRuns(dir);
    output({
      ok: false,
      error: 'multiple_runs',
      message: 'Multiple run instances found. Please specify --run.',
      runs: runs.map(r => ({ id: r.id, status: r.status, summary: r.summary })),
    });
    return;
  }

  const state = loadState(dir, runId);
  const step = getStep(wf, stepId);
  const stepState = getStepState(state, stepId);

  stepState.status = 'gate_failed';
  stepState.failed_at = now();
  stepState.fail_reason = reason || 'Gate failed';
  stepState.loop_iteration = (stepState.loop_iteration || 0);

  appendHistory(dir, runId, 'gate_failed', {
    step: step.id,
    reason: reason || 'Gate failed',
    iteration: stepState.loop_iteration,
  });

  const canLoop = step.loop.enabled && stepState.loop_iteration < step.loop.max_iterations;

  saveState(dir, runId, state);

  output({
    ok: true,
    step: step.id,
    status: 'gate_failed',
    reason: reason || 'Gate failed',
    can_loop: canLoop,
    loop_iteration: stepState.loop_iteration,
    max_iterations: step.loop.max_iterations,
    run_id: runId,
    message: canLoop
      ? 'Loop enabled. Call loop.mjs iterate, then re-execute step.'
      : 'Loop exhausted or disabled. Escalate to user.',
  });
}

function next(flags) {
  const { dir } = flags;
  if (!dir) fail('--dir is required');

  const wf = loadWorkflow(dir);
  const runId = resolveRunId(dir, flags, wf);
  if (!runId) {
    const runs = listRuns(dir);
    output({
      ok: false,
      error: 'multiple_runs',
      message: 'Multiple run instances found. Please specify --run.',
      runs: runs.map(r => ({ id: r.id, status: r.status, summary: r.summary })),
    });
    return;
  }

  const state = loadState(dir, runId);

  if (state.status === 'completed') {
    output({ ok: true, next_step: null, workflow_completed: true, run_id: runId });
    return;
  }

  const readySteps = getReadySteps(wf, state);

  if (readySteps.length === 0) {
    const blocked = getBlockedSteps(wf, state);
    if (blocked.length > 0) {
      output({
        ok: true,
        next_step: null,
        blocked_steps: blocked.map(b => ({
          id: b.step.id,
          name: b.step.name,
          blocked_by: b.blockedBy,
        })),
        run_id: runId,
        message: 'No steps ready - waiting for dependencies',
      });
      return;
    }

    output({ ok: true, next_step: null, workflow_completed: true, run_id: runId });
    return;
  }

  output({
    ok: true,
    next_step: readySteps[0],
    ready_steps: readySteps.map(s => ({
      id: s.id,
      name: s.name,
      instruction: s.instruction,
      artifact: s.artifact,
      dependsOn: s.dependsOn || [],
    })),
    parallel_execution: readySteps.length > 1,
    run_id: runId,
  });
}

function ready(flags) {
  const { dir } = flags;
  if (!dir) fail('--dir is required');

  const wf = loadWorkflow(dir);
  const runId = resolveRunId(dir, flags, wf);
  if (!runId) {
    const runs = listRuns(dir);
    output({
      ok: false,
      error: 'multiple_runs',
      message: 'Multiple run instances found. Please specify --run.',
      runs: runs.map(r => ({ id: r.id, status: r.status, summary: r.summary })),
    });
    return;
  }

  const state = loadState(dir, runId);

  const readySteps = getReadySteps(wf, state);
  const blockedSteps = getBlockedSteps(wf, state);
  const inProgressSteps = wf.steps.filter(s => {
    const stepState = state.step_states[s.id];
    return stepState?.status === 'in_progress' || stepState?.status === 'gate_pending';
  });

  output({
    ok: true,
    workflow: wf.name,
    run_id: runId,
    status: state.status,
    ready_steps: readySteps.map(s => ({
      id: s.id,
      name: s.name,
      instruction: s.instruction,
      artifact: s.artifact,
      dependsOn: s.dependsOn || [],
    })),
    ready_count: readySteps.length,
    in_progress: inProgressSteps.map(s => ({
      id: s.id,
      name: s.name,
      status: state.step_states[s.id]?.status,
    })),
    blocked: blockedSteps.map(b => ({
      id: b.step.id,
      name: b.step.name,
      blocked_by: b.blockedBy,
    })),
    parallel_available: readySteps.length > 1,
  });
}

function status(flags) {
  const { dir } = flags;
  if (!dir) fail('--dir is required');

  let wf = loadWorkflow(dir);

  // Migrate to v3 if needed
  const schema = detectSchema(wf);
  if (schema !== 'v3') {
    wf = migrateToV3(wf, dir);
  }

  const runs = listRuns(dir);

  // If no runs, return workflow info
  if (runs.length === 0) {
    output({
      ok: true,
      workflow: wf.name,
      status: 'no_runs',
      total_steps: wf.steps.length,
      runs_count: 0,
      message: 'No run instances found. Use session run to create one.',
    });
    return;
  }

  // Resolve run ID
  const runId = resolveRunId(dir, flags, wf);
  if (!runId) {
    // Multiple runs - list them for user to choose
    output({
      ok: true,
      workflow: wf.name,
      status: 'multiple_runs',
      total_steps: wf.steps.length,
      runs_count: runs.length,
      runs: runs.map(r => ({
        id: r.id,
        status: r.status,
        summary: r.summary,
        started_at: r.started_at,
      })),
      message: 'Multiple run instances found. Specify --run to see details.',
    });
    return;
  }

  const state = loadState(dir, runId);

  const currentStep = state.current_step
    ? wf.steps.find(s => s.id === state.current_step)
    : null;

  const currentStepState = state.current_step
    ? state.step_states[state.current_step]
    : null;

  // Check if current step has artifact
  let hasArtifact = false;
  if (currentStep) {
    const wfRoot = getWorkflowRoot(dir);
    const resolved = resolveArtifact(currentStep.artifact, currentStep.id);
    const artifactPath = join(wfRoot, 'runs', runId, resolved.path);
    hasArtifact = existsSync(artifactPath);
  }

  const history = loadHistory(dir, runId);
  const lastEvent = history.length > 0 ? history[history.length - 1] : null;

  const readySteps = getReadySteps(wf, state);
  const blockedSteps = getBlockedSteps(wf, state);

  output({
    ok: true,
    workflow: wf.name,
    run_id: runId,
    status: state.status,
    total_steps: wf.steps.length,
    completed_steps: (state.completed_steps || []).length,
    current_step: currentStep ? {
      id: currentStep.id,
      name: currentStep.name,
      status: currentStepState?.status || 'unknown',
      instruction: currentStep.instruction,
      has_artifact: hasArtifact,
      dependsOn: currentStep.dependsOn || [],
    } : null,
    ready_steps: readySteps.length,
    blocked_steps: blockedSteps.length,
    steps_summary: wf.steps.map(s => ({
      id: s.id,
      name: s.name,
      status: state.step_states[s.id]?.status || 'pending',
      dependsOn: s.dependsOn || [],
    })),
    last_event: lastEvent,
    runs_count: runs.length,
  });
}

// ── Main ──────────────────────────────────────────────────

const { command, flags } = parseArgs(process.argv.slice(2));

switch (command) {
  case 'start':    start(flags); break;
  case 'complete': complete(flags); break;
  case 'fail':     markFail(flags); break;
  case 'next':     next(flags); break;
  case 'ready':    ready(flags); break;
  case 'status':   status(flags); break;
  default:         fail(`Unknown command: ${command}. Use start|complete|fail|next|ready|status`);
}