/**
 * Workflow Engine — Gate Runner
 *
 * Pluggable quality gate evaluation with deterministic pass/fail logic.
 *
 * Commands:
 *   run        --dir <path> --step <id>    Get gate config (what to run)
 *   result     --dir <path> --step <id>    Evaluate gate result file → pass/fail
 *   auto_retry --dir <path> --step <id>    Auto-retry failed step with loop support
 *   extract    --dir <path> --step <id>    Extract failure reason from gate result
 *
 * Gate types:
 *   review     — LLM reviews artifact (Skill writes gate result JSON)
 *   command    — Shell command (exit 0 = pass)
 *   tool       — MCP tool (Skill invokes, writes result)
 *   manual     — User confirms via AskUserQuestion
 *   script     — Execute custom script, parse output for pass/fail (NEW)
 *   llm        — Use LLM to evaluate artifact quality (NEW)
 *   composite  — Combine multiple gate conditions (NEW)
 *
 * Gate result file: gates/{step_id}-{step_name}-gate.json
 */

import {
  readJSON, writeJSON, workflowPath, getWorkflowRoot,
  now, parseArgs, output, fail, fingerprint,
  migrateToV3, listRuns, getStatePath, getHistoryPath, detectSchema,
  resolveArtifact, parseManifest,
} from './utils.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

// ── Helpers ───────────────────────────────────────────────

function loadWorkflow(dir) {
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

function saveState(dir, runId, state) {
  state.updated_at = now();
  writeJSON(getStatePath(dir, runId), state);
}

function getStep(wf, stepId) {
  const id = Number(stepId);
  return wf.steps.find(s => s.id === id);
}

function gateResultPath(dir, runId, step) {
  const wfRoot = getWorkflowRoot(dir);
  return join(wfRoot, 'runs', runId, 'gates', `${String(step.id).padStart(2, '0')}-${step.name}-gate.json`);
}

function emitHook(dir, runId, event, data) {
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
    console.error(`[Hook Error] ${runId}:`, e.message);
  }
}

/**
 * Trigger memory-agent to generate summary for a completed step.
 * Non-blocking - logs errors but doesn't fail the workflow.
 */
function triggerMemoryAgent(dir, runId, stepId, projectRoot) {
  try {
    execSync(`node engine/memory-agent.mjs summarize --dir "${dir}" --run "${runId}" --step ${stepId}`, {
      cwd: projectRoot,
      encoding: 'utf-8',
      timeout: 15000,
    });
  } catch (e) {
    // Memory agent is non-blocking — log error but don't fail
    console.error(`[Memory Agent Error] Failed to generate summary for step ${stepId}:`, e.message);
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

function triggerEvolve(dir, runId, projectRoot) {
  try {
    execSync(`node engine/evolve.mjs extract --dir "${dir}" --run "${runId}"`, {
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

function triggerHandoff(dir, runId, stepId, projectRoot) {
  try {
    execSync(`node engine/handoff.mjs generate --dir "${dir}" --run "${runId}" --step ${stepId}`, {
      cwd: projectRoot,
      encoding: 'utf-8',
      timeout: 10000,
    });
  } catch (e) {
    console.error(`[Handoff Error] Failed to generate handoff for step ${stepId}:`, e.message);
  }
}

// ── Auto-Loop Helpers ────────────────────────────────────────

/**
 * Extract failure reason from gate result.
 * @param {object} gateResult
 * @returns {object} { summary, details, suggestions }
 */
function extractFailureReason(gateResult) {
  const findings = gateResult.findings || [];
  
  if (findings.length === 0) {
    return {
      summary: gateResult.result === 'fail' ? 'Gate failed without specific findings' : 'Unknown failure',
      details: [],
      suggestions: [],
    };
  }
  
  // Group by severity
  const critical = findings.filter(f => f.severity === 'critical');
  const high = findings.filter(f => f.severity === 'high');
  const medium = findings.filter(f => f.severity === 'medium');
  const low = findings.filter(f => f.severity === 'low');
  
  const summaryParts = [];
  if (critical.length > 0) summaryParts.push(`${critical.length} critical`);
  if (high.length > 0) summaryParts.push(`${high.length} high`);
  if (medium.length > 0) summaryParts.push(`${medium.length} medium`);
  if (low.length > 0) summaryParts.push(`${low.length} low`);
  
  const summary = `Gate failed with ${summaryParts.join(', ')} issue(s)`;
  
  const details = findings.map(f => ({
    severity: f.severity,
    title: f.title || 'Issue',
    detail: f.detail || '',
  }));
  
  const suggestions = findings
    .filter(f => f.suggestion)
    .map(f => f.suggestion);
  
  return { summary, details, suggestions };
}

/**
 * Calculate exponential backoff for auto-loop.
 * @param {number} iteration
 * @param {object} config
 * @returns {number} Wait time in ms
 */
function calculateBackoff(iteration, config = {}) {
  const { baseMs = 2000, multiplier = 2, maxMs = 60000 } = config;
  const delay = Math.min(baseMs * Math.pow(multiplier, iteration), maxMs);
  // Add jitter (±10%)
  const jitter = delay * 0.1 * (Math.random() * 2 - 1);
  return Math.round(delay + jitter);
}

/**
 * Evolve step parameters based on failure reason.
 * @param {object} step
 * @param {object} failureReason
 * @param {number} iteration
 * @returns {object} Evolved instruction/context
 */
function evolveStepParams(step, failureReason, iteration) {
  const evolved = {
    instruction: step.instruction,
    additionalContext: [],
  };
  
  // Add failure context to instruction
  if (failureReason.summary) {
    evolved.additionalContext.push(`Previous attempt failed: ${failureReason.summary}`);
  }
  
  // Add suggestions as context
  if (failureReason.suggestions && failureReason.suggestions.length > 0) {
    evolved.additionalContext.push('Suggestions for improvement:');
    failureReason.suggestions.forEach((s, i) => {
      evolved.additionalContext.push(`${i + 1}. ${s}`);
    });
  }
  
  // Add iteration context
  evolved.additionalContext.push(`This is attempt ${iteration + 1}.`);
  
  return evolved;
}

// ── Commands ──────────────────────────────────────────────

function run(flags) {
  const { dir, step: stepId, run: runId } = flags;
  if (!dir) fail('--dir is required');
  if (!stepId) fail('--step is required');

  let wf = loadWorkflow(dir);

  // Migrate to v3 if needed
  const schema = detectSchema(wf);
  if (schema !== 'v3') {
    wf = migrateToV3(wf, dir);
  }

  // Resolve run ID
  const resolvedRunId = runId || (listRuns(dir).length === 1 ? listRuns(dir)[0].id : null);
  if (!resolvedRunId) {
    const runs = listRuns(dir);
    output({
      ok: false,
      error: 'multiple_runs',
      message: 'Multiple run instances found. Please specify --run.',
      runs: runs.map(r => ({ id: r.id, status: r.status, summary: r.summary })),
    });
    return;
  }

  const step = getStep(wf, stepId);
  if (!step) fail(`Step ${stepId} not found`);

  // Check if gate is enabled
  if (!step.gate || !step.gate.enabled) {
    output({ ok: true, skip: true, message: 'Gate disabled for this step' });
    return;
  }

  const wfRoot = getWorkflowRoot(dir);
  const resolved = resolveArtifact(step.artifact, stepId);
  const artifactPath = resolved.type === 'none'
    ? null
    : join(wfRoot, 'runs', resolvedRunId, resolved.path);
  const hasArtifact = artifactPath ? existsSync(artifactPath) : false;

  const gatePath = gateResultPath(dir, resolvedRunId, step);

  // Get project root (parent of .workflows) for command execution
  const projectRoot = join(wfRoot, '..', '..');

  switch (step.gate.type) {
    case 'command': {
      // Run shell command, capture result
      const cmd = step.gate.command;
      if (!cmd) fail('Gate type is "command" but no command specified');

      try {
        const stdout = execSync(cmd, {
          cwd: projectRoot,
          encoding: 'utf-8',
          timeout: 60000,
          env: {
            ...process.env,
            WORKFLOW_DIR: wfRoot,
            STEP_NAME: step.name,
            ARTIFACT_PATH: artifactPath,
          },
        });

        // Command succeeded → write pass result
        const result = {
          result: 'pass',
          findings: [],
          reviewed_by: `command:${cmd}`,
          stdout: stdout.trim(),
          at: now(),
        };
        writeJSON(gatePath, result);
        output({ ok: true, type: 'command', result: 'pass', gate_file: gatePath });
      } catch (e) {
        // Command failed → write fail result
        const result = {
          result: 'fail',
          findings: [{
            severity: 'high',
            title: 'Gate command failed',
            detail: e.stderr?.toString().trim() || e.message,
            suggestion: 'Fix the issues reported by the gate command',
          }],
          reviewed_by: `command:${cmd}`,
          stdout: e.stdout?.toString().trim() || '',
          stderr: e.stderr?.toString().trim() || '',
          at: now(),
        };
        writeJSON(gatePath, result);
        output({ ok: true, type: 'command', result: 'fail', gate_file: gatePath });
      }
      break;
    }

    case 'review': {
      // Build review target based on artifact type
      let reviewTarget;
      if (resolved.type === 'none') {
        // No artifact — review based on step summary / handoff
        const state = readJSON(getStatePath(dir, resolvedRunId));
        const stepState = state?.step_states?.[stepId] || {};
        const summary = stepState.structured_summary || stepState.summary || null;
        reviewTarget = {
          type: 'summary',
          summary,
          message: `This step has no artifact (handoff-only). Review the step summary to evaluate completion. Write gate result JSON to ${gatePath}.`,
        };
      } else if (resolved.type === 'reference' && hasArtifact) {
        const manifestContent = readFileSync(artifactPath, 'utf-8');
        const manifest = parseManifest(manifestContent);
        reviewTarget = {
          type: 'reference',
          manifest_path: resolved.path,
          summary: manifest.summary,
          files: manifest.files,
          message: 'Review the files listed in the manifest. Read each file, then evaluate against criteria.',
        };
      } else {
        reviewTarget = {
          type: 'content',
          artifact_path: resolved.path,
          message: `Review the artifact at ${resolved.path}. Write gate result JSON to ${gatePath}.`,
        };
      }

      output({
        ok: true,
        type: 'review',
        needs_llm: true,
        review_target: reviewTarget,
        artifact_path: resolved.path,
        has_artifact: hasArtifact,
        gate_file: gatePath,
        criteria: step.gate.criteria || null,
        schema: {
          result: 'pass | fail',
          score: 'optional number 0-100',
          findings: '[{ severity, title, detail, suggestion }]',
          reviewed_by: 'string',
        },
      });
      break;
    }

    case 'tool': {
      // Return info for Skill to invoke the MCP tool
      output({
        ok: true,
        type: 'tool',
        needs_llm: true,
        tool_name: step.gate.tool,
        artifact_path: resolved.path,
        gate_file: gatePath,
        message: `Invoke tool "${step.gate.tool}", write result to ${gatePath}.`,
      });
      break;
    }

    case 'manual': {
      output({
        ok: true,
        type: 'manual',
        needs_user: true,
        gate_file: gatePath,
        message: 'Ask user to review and approve/reject this step.',
      });
      break;
    }

    // ── NEW: Script Gate ────────────────────────────────────
    case 'script': {
      // Execute custom script, parse output for pass/fail
      const scriptPath = step.gate.script;
      if (!scriptPath) fail('Gate type is "script" but no script specified');

      // Resolve script path (relative to workflow dir or absolute)
      const resolvedScript = scriptPath.startsWith('/')
        ? scriptPath
        : join(wfRoot, scriptPath);

      if (!existsSync(resolvedScript)) {
        fail(`Script not found: ${resolvedScript}`);
      }

      try {
        const stdout = execSync(`"${resolvedScript}"`, {
          cwd: wfRoot,
          encoding: 'utf-8',
          timeout: step.gate.timeout || 120000,
          env: {
            ...process.env,
            WORKFLOW_DIR: wfRoot,
            STEP_NAME: step.name,
            STEP_ID: String(step.id),
            ARTIFACT_PATH: artifactPath,
            GATE_TYPE: 'script',
          },
        });

        // Parse script output
        // Script should output JSON or simple "PASS"/"FAIL" text
        let result;
        const outputLines = stdout.trim().split('\n');
        const lastLine = outputLines[outputLines.length - 1];
        
        // Try to parse as JSON first
        try {
          const parsed = JSON.parse(lastLine);
          result = {
            result: parsed.result || (parsed.pass ? 'pass' : 'fail'),
            findings: parsed.findings || [],
            score: parsed.score,
            reviewed_by: `script:${scriptPath}`,
            stdout: stdout.trim(),
            at: now(),
          };
        } catch {
          // Fall back to text parsing
          const isPass = /^PASS/i.test(lastLine.trim());
          result = {
            result: isPass ? 'pass' : 'fail',
            findings: isPass ? [] : [{
              severity: 'high',
              title: 'Script check failed',
              detail: stdout.trim(),
              suggestion: 'Review script output for details',
            }],
            reviewed_by: `script:${scriptPath}`,
            stdout: stdout.trim(),
            at: now(),
          };
        }

        writeJSON(gatePath, result);
        output({ ok: true, type: 'script', result: result.result, gate_file: gatePath });
      } catch (e) {
        // Script execution failed
        const result = {
          result: 'fail',
          findings: [{
            severity: 'high',
            title: 'Script execution failed',
            detail: e.stderr?.toString().trim() || e.message,
            suggestion: 'Check script permissions and dependencies',
          }],
          reviewed_by: `script:${scriptPath}`,
          stdout: e.stdout?.toString().trim() || '',
          stderr: e.stderr?.toString().trim() || '',
          at: now(),
        };
        writeJSON(gatePath, result);
        output({ ok: true, type: 'script', result: 'fail', gate_file: gatePath });
      }
      break;
    }

    // ── NEW: LLM Gate ───────────────────────────────────────
    case 'llm': {
      // Use LLM to evaluate artifact quality
      const criteria = step.gate.criteria || 'Evaluate the quality and correctness of the artifact';
      const model = step.gate.model || 'default';
      const threshold = step.gate.threshold || 70;

      output({
        ok: true,
        type: 'llm',
        needs_llm: true,
        artifact_path: step.artifact,
        has_artifact: hasArtifact,
        gate_file: gatePath,
        criteria,
        model,
        threshold,
        message: `Use LLM to evaluate artifact against criteria. Score must be >= ${threshold} to pass.`,
        schema: {
          result: 'pass | fail',
          score: 'number 0-100 (required)',
          findings: '[{ severity, title, detail, suggestion }]',
          reasoning: 'string - explanation of the score',
          reviewed_by: 'string - model name',
        },
        prompt_template: step.gate.prompt_template || null,
      });
      break;
    }

    // ── NEW: Composite Gate ─────────────────────────────────
    case 'composite': {
      // Combine multiple gate conditions
      const gates = step.gate.gates || [];
      if (gates.length === 0) fail('Composite gate requires at least one sub-gate');

      const mode = step.gate.mode || 'all'; // 'all' (AND) or 'any' (OR)
      
      output({
        ok: true,
        type: 'composite',
        gates: gates.map((g, i) => ({
          id: i,
          type: g.type,
          config: g,
        })),
        mode,
        gate_file: gatePath,
        message: `Evaluate ${gates.length} gate(s) in ${mode} mode. All must pass for 'all' mode, any for 'any' mode.`,
      });
      break;
    }

    default:
      fail(`Unknown gate type: ${step.gate.type}`);
  }
}

function result(flags) {
  const { dir, step: stepId, run: runId } = flags;
  if (!dir) fail('--dir is required');
  if (!stepId) fail('--step is required');

  let wf = loadWorkflow(dir);

  // Migrate to v3 if needed
  const schema = detectSchema(wf);
  if (schema !== 'v3') {
    wf = migrateToV3(wf, dir);
  }

  // Resolve run ID
  const resolvedRunId = runId || (listRuns(dir).length === 1 ? listRuns(dir)[0].id : null);
  if (!resolvedRunId) {
    const runs = listRuns(dir);
    output({
      ok: false,
      error: 'multiple_runs',
      message: 'Multiple run instances found. Please specify --run.',
      runs: runs.map(r => ({ id: r.id, status: r.status, summary: r.summary })),
    });
    return;
  }

  const step = getStep(wf, stepId);
  if (!step) fail(`Step ${stepId} not found`);

  const gatePath = gateResultPath(dir, resolvedRunId, step);
  const gateResult = readJSON(gatePath);
  if (!gateResult) fail(`No gate result found at ${gatePath}`);

  // ── Deterministic decision logic ────────────────────────
  const findings = gateResult.findings || [];
  const hasCritical = findings.some(f => f.severity === 'critical');
  const highCount = findings.filter(f => f.severity === 'high').length;
  const highThreshold = step.gate.high_threshold ?? 3;

  let decision;
  if (gateResult.result === 'pass' && !hasCritical && highCount < highThreshold) {
    decision = 'pass';
  } else if (hasCritical) {
    decision = 'fail';
  } else if (highCount >= highThreshold) {
    decision = 'fail';
  } else if (gateResult.result === 'fail') {
    decision = 'fail';
  } else {
    decision = 'pass';
  }

  // ── Update state (v3: in run directory) ───────────────────────
  const state = loadState(dir, resolvedRunId);
  const stepState = state.step_states[step.id] || {};

  if (decision === 'pass') {
    stepState.status = 'completed';
    stepState.completed_at = now();
    stepState.gate_result = 'pass';
    stepState.gate_details = gatePath;

    if (!state.completed_steps) state.completed_steps = [];
    if (!state.completed_steps.includes(step.id)) {
      state.completed_steps.push(step.id);
    }

    // Find next step (DAG-aware)
    const readySteps = wf.steps.filter(s => {
      const st = state.step_states[s.id];
      const isPending = !st || st.status === 'pending';
      const depsMet = (s.dependsOn || []).every(depId => {
        const depState = state.step_states[depId];
        return depState?.status === 'completed';
      });
      return isPending && depsMet;
    });
    const nextStep = readySteps[0] || null;

    if (nextStep) {
      state.current_step = nextStep.id;
    } else {
      // Check if all steps completed
      const allCompleted = wf.steps.every(s => {
        const st = state.step_states[s.id];
        return st?.status === 'completed';
      });
      if (allCompleted) {
        state.status = 'completed';
        state.current_step = null;
        state.completed_at = now();
      }
    }

    // Update step_states
    state.step_states[step.id] = stepState;
    saveState(dir, resolvedRunId, state);

    // Append to history
    const history = readJSON(getHistoryPath(dir, resolvedRunId)) || [];
    history.push({ event: 'gate_passed', step: step.id, score: gateResult.score || null, findings_count: findings.length, at: now() });
    history.push({ event: 'step_completed', step: step.id, at: now() });
    if (!nextStep && state.status === 'completed') {
      history.push({ event: 'workflow_completed', at: now() });
    }
    writeJSON(getHistoryPath(dir, resolvedRunId), history);

    // Emit hooks
    const wfRoot = getWorkflowRoot(dir);
    const projectRoot = join(wfRoot, '..', '..');
    emitHook(dir, resolvedRunId, 'on_gate_pass', { step: step.id, name: step.name, score: gateResult.score, findings_count: findings.length });
    emitHook(dir, resolvedRunId, 'on_step_complete', { step: step.id, name: step.name, artifact: step.artifact, status: 'completed' });

    // Incremental evolution: extract lessons from this step immediately
    triggerStepEvolve(dir, resolvedRunId, step.id, projectRoot);

    // Generate handoff for next step
    triggerHandoff(dir, resolvedRunId, step.id, projectRoot);

    if (!nextStep && state.status === 'completed') {
      emitHook(dir, resolvedRunId, 'on_workflow_complete', { workflow: wf.name });
      triggerEvolve(dir, resolvedRunId, projectRoot);
    }

    output({
      ok: true,
      step: step.id,
      decision: 'pass',
      score: gateResult.score || null,
      findings_count: findings.length,
      next_step: nextStep || null,
      workflow_completed: !nextStep && state.status === 'completed',
      run_id: resolvedRunId,
    });
  } else {
    // Fail — check loop eligibility
    stepState.status = 'gate_failed';
    stepState.gate_result = 'fail';
    stepState.gate_details = gatePath;
    stepState.loop_iteration = (stepState.loop_iteration || 0);

    const canLoop = step.loop && step.loop.enabled && stepState.loop_iteration < (step.loop.max_iterations || 3);

    // Add finding fingerprints for convergence detection
    stepState.last_findings_fingerprints = findings.map(f =>
      fingerprint(`${f.severity}:${(f.title || '').toLowerCase().trim()}`)
    );

    // Update step_states
    state.step_states[step.id] = stepState;
    saveState(dir, resolvedRunId, state);

    // Append to history
    const history = readJSON(getHistoryPath(dir, resolvedRunId)) || [];
    history.push({
      event: 'gate_failed',
      step: step.id,
      findings_count: findings.length,
      critical: hasCritical,
      high_count: highCount,
      at: now(),
    });
    writeJSON(getHistoryPath(dir, resolvedRunId), history);

    // Emit hook
    emitHook(dir, resolvedRunId, 'on_gate_fail', { step: step.id, name: step.name, findings_count: findings.length, critical: hasCritical, can_loop: canLoop });

    output({
      ok: true,
      step: step.id,
      decision: 'fail',
      findings,
      can_loop: canLoop,
      loop_iteration: stepState.loop_iteration,
      max_iterations: step.loop?.max_iterations || 3,
      run_id: resolvedRunId,
      message: canLoop
        ? 'Gate failed. Loop available — fix issues and retry.'
        : 'Gate failed. No loop or loop exhausted — escalate to user.',
    });
  }
}

// ── NEW: Auto-Retry Command ────────────────────────────────────

async function autoRetry(flags) {
  const { dir, step: stepId, run: runId, inject } = flags;
  if (!dir) fail('--dir is required');
  if (!stepId) fail('--step is required');

  let wf = loadWorkflow(dir);

  // Migrate to v3 if needed
  if (!wf.schema_version || wf.schema_version === '1.0') {
    wf = migrateToV3(wf, dir);
  }

  // Resolve run ID
  const resolvedRunId = runId || (listRuns(dir).length === 1 ? listRuns(dir)[0].id : null);
  if (!resolvedRunId) {
    const runs = listRuns(dir);
    output({
      ok: false,
      error: 'multiple_runs',
      message: 'Multiple run instances found. Please specify --run.',
      runs: runs.map(r => ({ id: r.id, status: r.status, summary: r.summary })),
    });
    return;
  }

  const step = getStep(wf, stepId);
  if (!step) fail(`Step ${stepId} not found`);

  const state = loadState(dir, resolvedRunId);
  const stepState = state.step_states?.[step.id] || {};
  const gatePath = gateResultPath(dir, resolvedRunId, step);
  const gateResult = readJSON(gatePath);

  if (!gateResult) {
    fail(`No gate result found at ${gatePath}`);
  }

  if (gateResult.result === 'pass') {
    output({ ok: false, error: 'Gate already passed, no retry needed' });
    return;
  }

  // Check if auto-loop is enabled
  const autoLoop = step.gate.autoLoop || step.loop?.autoLoop || false;
  const maxRetries = step.gate.maxRetries || step.loop?.max_iterations || 3;
  const currentIteration = stepState.loop_iteration || 0;

  if (!autoLoop) {
    output({
      ok: false,
      error: 'Auto-loop not enabled for this gate',
      suggestion: 'Enable autoLoop in gate or loop configuration',
    });
    return;
  }

  if (currentIteration >= maxRetries) {
    output({
      ok: false,
      error: 'Max retries exceeded',
      iteration: currentIteration,
      max_retries: maxRetries,
      escalate: true,
    });
    return;
  }

  // Extract failure reason
  const failureReason = extractFailureReason(gateResult);

  // Calculate backoff
  const backoffConfig = step.gate.backoff || step.loop?.backoff || {};
  const backoffMs = calculateBackoff(currentIteration, backoffConfig);

  // Evolve step parameters if enabled
  const evolveOnRetry = step.gate.evolveOnRetry !== false;
  const evolvedParams = evolveOnRetry
    ? evolveStepParams(step, failureReason, currentIteration)
    : null;

  // Store failure context for next iteration
  stepState.retry_history = stepState.retry_history || [];
  stepState.retry_history.push({
    iteration: currentIteration,
    failure_reason: failureReason,
    at: now(),
  });

  // Increment iteration
  stepState.loop_iteration = currentIteration + 1;
  stepState.status = 'pending'; // Allow re-execution

  // Update state
  state.step_states[step.id] = stepState;
  saveState(dir, resolvedRunId, state);

  // Update history
  const history = readJSON(getHistoryPath(dir, resolvedRunId)) || [];
  history.push({
    event: 'auto_retry',
    step: step.id,
    iteration: stepState.loop_iteration,
    failure_summary: failureReason.summary,
    at: now(),
  });
  writeJSON(getHistoryPath(dir, resolvedRunId), history);

  // Emit hook
  emitHook(dir, resolvedRunId, 'on_auto_retry', {
    step: step.id,
    name: step.name,
    iteration: stepState.loop_iteration,
    failure_summary: failureReason.summary,
    backoff_ms: backoffMs,
  });

  const result = {
    ok: true,
    step: step.id,
    iteration: stepState.loop_iteration,
    max_retries: maxRetries,
    remaining: maxRetries - stepState.loop_iteration,
    failure_reason: failureReason,
    backoff_ms: backoffMs,
    evolved_params: evolvedParams,
    inject_context: inject === 'true' || inject === true ? {
      type: 'failure_context',
      summary: failureReason.summary,
      suggestions: failureReason.suggestions,
      iteration: stepState.loop_iteration,
    } : null,
    message: `Auto-retry ${stepState.loop_iteration}/${maxRetries}. Wait ${backoffMs}ms before re-executing.`,
    run_id: resolvedRunId,
  };

  output(result);
}

// ── NEW: Extract Command ───────────────────────────────────────

function extract(flags) {
  const { dir, step: stepId, run: runId } = flags;
  if (!dir) fail('--dir is required');
  if (!stepId) fail('--step is required');

  let wf = loadWorkflow(dir);

  // Migrate to v3 if needed
  const schema = detectSchema(wf);
  if (schema !== 'v3') {
    wf = migrateToV3(wf, dir);
  }

  const step = getStep(wf, stepId);
  if (!step) fail(`Step ${stepId} not found`);

  // Resolve run ID
  const resolvedRunId = runId || (listRuns(dir).length === 1 ? listRuns(dir)[0].id : null);
  if (!resolvedRunId) {
    const runs = listRuns(dir);
    output({
      ok: false,
      error: 'multiple_runs',
      message: 'Multiple run instances found. Please specify --run.',
      runs: runs.map(r => ({ id: r.id, status: r.status, summary: r.summary })),
    });
    return;
  }

  const gatePath = gateResultPath(dir, resolvedRunId, step);
  const gateResult = readJSON(gatePath);

  if (!gateResult) {
    fail(`No gate result found at ${gatePath}`);
  }

  const failureReason = extractFailureReason(gateResult);

  output({
    ok: true,
    step: step.id,
    gate_result: gateResult.result,
    failure_reason: failureReason,
    raw_findings: gateResult.findings,
    score: gateResult.score,
  });
}

// ── Main ──────────────────────────────────────────────────

const { command, flags } = parseArgs(process.argv.slice(2));

async function main() {
  switch (command) {
    case 'run':        await run(flags); break;
    case 'result':     await result(flags); break;
    case 'auto_retry': await autoRetry(flags); break;
    case 'extract':    extract(flags); break;
    default:           fail(`Unknown command: ${command}. Use run|result|auto_retry|extract`);
  }
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
