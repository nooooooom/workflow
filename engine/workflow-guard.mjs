#!/usr/bin/env node
/**
 * Workflow Guard — Claude Code Hooks Safety Net
 *
 * Runs as a PreToolUse hook in Claude Code to enforce workflow rules:
 * - Must be in an active workflow directory to make changes
 * - Must call advance.mjs start before editing content
 * - Artifacts must be written to correct locations
 *
 * Exit codes:
 *   0 - Allow operation (not in workflow dir, or rules satisfied)
 *   2 - Block operation (violates workflow rules)
 *
 * Disable guard:
 *   export WORKFLOW_GUARD_DISABLED=true
 *   or set "guard.disabled": true in guard-rules.json
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname, basename, relative } from 'node:path';
import { homedir } from 'node:os';

// ── Configuration ─────────────────────────────────────────

const GUARD_RULES_FILE = 'engine/guard-rules.json';
const WORKFLOW_MARKER = 'workflow.json';
const ARTIFACTS_DIR = 'artifacts';
const STEPS_DIR = 'steps';
const GATES_DIR = 'gates';

// Environment variables
const ENV_DISABLED = 'WORKFLOW_GUARD_DISABLED';
const ENV_DEBUG = 'WORKFLOW_GUARD_DEBUG';

// ── Helpers ───────────────────────────────────────────────

function debug(...args) {
  if (process.env[ENV_DEBUG]) {
    console.error('[WorkflowGuard]', ...args);
  }
}

function readJSON(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function writeJSON(filePath, data) {
  writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

function isDisabled() {
  // Check environment variable
  if (process.env[ENV_DISABLED] === 'true') {
    debug('Guard disabled by environment variable');
    return true;
  }
  return false;
}

function loadGuardRules(projectRoot) {
  const rulesPath = join(projectRoot, GUARD_RULES_FILE);
  const rules = readJSON(rulesPath);
  if (!rules) {
    // Return defaults
    return {
      enabled: true,
      requireStartBeforeEdit: true,
      requireArtifactLocation: true,
      requireGateFlow: true,
      disabled: false,
      excludedPaths: ['node_modules', '.git', 'dist', 'build'],
      messageTemplate: {
        notInWorkflow: 'Not in a workflow directory. Operation allowed.',
        noStartCalled: `⚠️ Workflow Guard: You must call \`advance.mjs start\` before editing workflow content.

Run: node engine/advance.mjs start --dir <workflow-dir> --step <step-id>`,
        wrongArtifactLocation: `⚠️ Workflow Guard: Artifacts must be written to the workflow's artifacts/ directory.

Expected path: {workflow-dir}/artifacts/{step-artifact}`,
        gateNotCompleted: `⚠️ Workflow Guard: Cannot proceed to next step until Gate passes.

Run: node engine/gate.mjs result --dir <workflow-dir> --step <step-id> --result PASS|FAIL`,
        generalViolation: `⚠️ Workflow Guard: {message}

See docs/guard-system.md for help.`
      }
    };
  }
  return rules;
}

/**
 * Find the workflow directory for a given path.
 * Walks up the directory tree to find a workflow.json.
 */
function findWorkflowDir(targetPath) {
  let current = resolve(targetPath);
  
  while (current !== '/' && current !== homedir()) {
    const markerPath = join(current, WORKFLOW_MARKER);
    if (existsSync(markerPath)) {
      return current;
    }
    current = dirname(current);
  }
  
  return null;
}

/**
 * Check if path is inside a workflow's artifacts directory.
 */
function isArtifactPath(path, workflowDir) {
  const rel = relative(workflowDir, path);
  return rel.startsWith(ARTIFACTS_DIR + '/') || rel.startsWith(ARTIFACTS_DIR + '\\');
}

/**
 * Check if path is inside a workflow's steps directory.
 */
function isStepPath(path, workflowDir) {
  const rel = relative(workflowDir, path);
  return rel.startsWith(STEPS_DIR + '/') || rel.startsWith(STEPS_DIR + '\\');
}

/**
 * Check if path is a gate file.
 */
function isGatePath(path, workflowDir) {
  const rel = relative(workflowDir, path);
  return rel.startsWith(GATES_DIR + '/') || rel.startsWith(GATES_DIR + '\\');
}

/**
 * Check if path is the workflow.json itself.
 */
function isWorkflowConfig(path, workflowDir) {
  const rel = relative(workflowDir, path);
  return rel === WORKFLOW_MARKER;
}

/**
 * Check if path is excluded by rules.
 */
function isExcluded(path, rules) {
  const pathParts = path.split(/[/\\]/);
  return rules.excludedPaths?.some(excluded => 
    pathParts.includes(excluded)
  );
}

/**
 * Get the current step state from workflow.
 */
function getCurrentStepState(workflow) {
  const currentStepId = workflow.state?.current_step;
  if (!currentStepId) return null;
  
  const stepState = workflow.state.step_states?.[currentStepId];
  const step = workflow.steps?.find(s => s.id === currentStepId);
  
  return { stepId: currentStepId, stepState, step };
}

// ── Rule Checks ───────────────────────────────────────────

/**
 * Check: Must call start before editing workflow content.
 */
function checkStartCalled(workflow, rules) {
  if (!rules.requireStartBeforeEdit) {
    return { passed: true };
  }
  
  const currentState = getCurrentStepState(workflow);
  
  // No current step - workflow might be completed or not started
  if (!currentState) {
    // Check if workflow is completed
    if (workflow.state?.status === 'completed') {
      return {
        passed: false,
        reason: 'workflowCompleted',
        message: `Workflow '${workflow.name}' is completed. No further edits allowed.`
      };
    }
    return {
      passed: false,
      reason: 'noStartCalled',
      message: `No step is currently active. Call \`advance.mjs start\` first.`
    };
  }
  
  const { stepId, stepState, step } = currentState;
  
  // Allow if step is in_progress or gate_pending
  if (stepState.status === 'in_progress' || stepState.status === 'gate_pending') {
    return { passed: true };
  }
  
  // Block if step is pending, completed, or failed without loop
  if (stepState.status === 'pending') {
    return {
      passed: false,
      reason: 'noStartCalled',
      message: `Step ${stepId} is pending. Call \`advance.mjs start --dir <workflow-dir> --step ${stepId}\` first.`
    };
  }
  
  if (stepState.status === 'completed') {
    return {
      passed: false,
      reason: 'stepCompleted',
      message: `Step ${stepId} is already completed. Use \`advance.mjs next\` to get the next step.`
    };
  }
  
  if (stepState.status === 'gate_failed') {
    // Allow if loop is possible
    const canLoop = step?.loop?.enabled && (stepState.loop_iteration || 0) < (step?.loop?.max_iterations || 3);
    if (canLoop) {
      return {
        passed: true,
        warning: `Step ${stepId} failed gate. You can retry with loop.mjs iterate.`
      };
    }
    return {
      passed: false,
      reason: 'gateFailed',
      message: `Step ${stepId} failed gate and no loop available. Escalate to user.`
    };
  }
  
  return { passed: true };
}

/**
 * Check: Artifacts must be written to correct location.
 */
function checkArtifactLocation(targetPath, workflow, workflowDir, rules) {
  if (!rules.requireArtifactLocation) {
    return { passed: true };
  }
  
  const { stepId, stepState, step } = getCurrentStepState(workflow);
  
  if (!step || !step.artifact) {
    // No artifact defined, allow any location in workflow dir
    return { passed: true };
  }
  
  const expectedArtifactPath = resolve(workflowDir, step.artifact);
  const targetAbsPath = resolve(targetPath);
  
  // Allow if writing to the expected artifact path
  if (targetAbsPath === expectedArtifactPath) {
    return { passed: true };
  }
  
  // Allow if writing to artifacts directory with any name (flexible)
  if (isArtifactPath(targetAbsPath, workflowDir)) {
    // Warn if not the expected name
    const expectedName = basename(step.artifact);
    const actualName = basename(targetAbsPath);
    if (expectedName !== actualName) {
      return {
        passed: true,
        warning: `Writing to ${actualName} but expected ${expectedName}. Consider using the standard artifact name.`
      };
    }
    return { passed: true };
  }
  
  // Block if writing outside artifacts directory for workflow content
  if (!isStepPath(targetAbsPath, workflowDir) && 
      !isGatePath(targetAbsPath, workflowDir) && 
      !isWorkflowConfig(targetAbsPath, workflowDir)) {
    return {
      passed: false,
      reason: 'wrongArtifactLocation',
      message: `Artifacts should be written to: ${step.artifact}\nCurrent target: ${relative(workflowDir, targetAbsPath)}`
    };
  }
  
  return { passed: true };
}

/**
 * Check: Gate flow must be followed.
 */
function checkGateFlow(workflow, rules) {
  if (!rules.requireGateFlow) {
    return { passed: true };
  }
  
  const { stepId, stepState, step } = getCurrentStepState(workflow);
  
  if (!step || !step.gate?.enabled) {
    return { passed: true };
  }
  
  // If step is gate_pending, user should run gate, not edit files
  if (stepState?.status === 'gate_pending') {
    return {
      passed: false,
      reason: 'gateNotCompleted',
      message: `Step ${stepId} is awaiting gate evaluation. Run gate.mjs result first.`
    };
  }
  
  return { passed: true };
}

// ── Main Guard Logic ──────────────────────────────────────

function runGuard() {
  // Parse stdin for tool info (Claude Code sends tool details)
  let toolInput = {};
  try {
    const stdin = readFileSync(0, 'utf-8');
    if (stdin.trim()) {
      toolInput = JSON.parse(stdin);
    }
  } catch (e) {
    debug('No stdin or parse error:', e.message);
  }
  
  const { tool, input } = toolInput;
  const targetPath = input?.file_path || input?.path || input?.filePath || '';
  
  debug('Tool:', tool);
  debug('Target path:', targetPath);
  
  // Get project root from argv or cwd
  const args = process.argv.slice(2);
  let projectRoot = args.find(a => a.startsWith('--project-root='))?.split('=')[1];
  if (!projectRoot) {
    projectRoot = process.cwd();
  }
  
  // Load rules
  const rules = loadGuardRules(projectRoot);
  
  // Check if disabled
  if (isDisabled() || rules.disabled) {
    debug('Guard is disabled, allowing operation');
    process.exit(0);
  }
  
  // If no target path, allow (non-file operations)
  if (!targetPath) {
    debug('No file path in tool input, allowing');
    process.exit(0);
  }
  
  const absTargetPath = resolve(projectRoot, targetPath);
  
  // Check if path is in excluded paths
  if (isExcluded(absTargetPath, rules)) {
    debug('Path is excluded, allowing');
    process.exit(0);
  }
  
  // Find workflow directory
  const workflowDir = findWorkflowDir(absTargetPath);
  
  if (!workflowDir) {
    debug('Not in a workflow directory, allowing');
    process.exit(0);
  }
  
  // Load workflow
  const workflowPath = join(workflowDir, WORKFLOW_MARKER);
  const workflow = readJSON(workflowPath);
  
  if (!workflow) {
    debug('Could not load workflow, allowing');
    process.exit(0);
  }
  
  debug('Workflow found:', workflow.name);
  debug('Current step:', workflow.state?.current_step);
  
  // Run checks
  
  // 1. Check start called
  const startResult = checkStartCalled(workflow, rules);
  if (!startResult.passed) {
    const message = rules.messageTemplate?.[startResult.reason] || startResult.message;
    console.error(message);
    process.exit(2);
  }
  if (startResult.warning) {
    console.error('⚠️ Warning:', startResult.warning);
  }
  
  // 2. Check artifact location (for Write/Edit operations)
  if (tool === 'Write' || tool === 'Edit') {
    const artifactResult = checkArtifactLocation(absTargetPath, workflow, workflowDir, rules);
    if (!artifactResult.passed) {
      const message = rules.messageTemplate?.[artifactResult.reason] || artifactResult.message;
      console.error(message);
      process.exit(2);
    }
    if (artifactResult.warning) {
      console.error('⚠️ Warning:', artifactResult.warning);
    }
  }
  
  // 3. Check gate flow
  const gateResult = checkGateFlow(workflow, rules);
  if (!gateResult.passed) {
    const message = rules.messageTemplate?.[gateResult.reason] || gateResult.message;
    console.error(message);
    process.exit(2);
  }
  
  // All checks passed
  debug('All checks passed, allowing operation');
  process.exit(0);
}

// ── CLI Entry Point ───────────────────────────────────────

// Also support direct CLI usage for testing
const args = process.argv.slice(2);
const command = args[0];

if (command === 'init-rules') {
  // Initialize guard-rules.json with defaults
  const rulesPath = join(process.cwd(), GUARD_RULES_FILE);
  if (existsSync(rulesPath)) {
    console.error('guard-rules.json already exists');
    process.exit(1);
  }
  
  const defaultRules = {
    enabled: true,
    requireStartBeforeEdit: true,
    requireArtifactLocation: true,
    requireGateFlow: true,
    disabled: false,
    excludedPaths: ['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.nuxt', 'out'],
    messageTemplate: {
      notInWorkflow: 'Not in a workflow directory. Operation allowed.',
      noStartCalled: `⚠️ Workflow Guard: You must call \`advance.mjs start\` before editing workflow content.

Run: node engine/advance.mjs start --dir <workflow-dir> --step <step-id>`,
      wrongArtifactLocation: `⚠️ Workflow Guard: Artifacts must be written to the workflow's artifacts/ directory.

Expected path: {workflow-dir}/artifacts/{step-artifact}`,
      gateNotCompleted: `⚠️ Workflow Guard: Cannot proceed to next step until Gate passes.

Run: node engine/gate.mjs result --dir <workflow-dir> --step <step-id> --result PASS|FAIL`,
      generalViolation: `⚠️ Workflow Guard: {message}

See docs/guard-system.md for help.`
    }
  };
  
  writeJSON(rulesPath, defaultRules);
  console.log('Created engine/guard-rules.json with default settings');
  process.exit(0);
}

if (command === 'status') {
  // Show guard status for current directory
  const cwd = process.cwd();
  const workflowDir = findWorkflowDir(cwd);
  const rules = loadGuardRules(cwd);
  
  console.log(JSON.stringify({
    guardEnabled: !isDisabled() && !rules.disabled,
    workflowDir,
    rules: {
      requireStartBeforeEdit: rules.requireStartBeforeEdit,
      requireArtifactLocation: rules.requireArtifactLocation,
      requireGateFlow: rules.requireGateFlow
    }
  }, null, 2));
  process.exit(0);
}

if (command === 'test') {
  // Test mode: simulate Guard check for a given path
  const targetPath = args[1] || '';
  const requireStart = args.includes('--require-start');
  
  if (!targetPath) {
    console.error('Usage: workflow-guard.mjs test <path> [--require-start]');
    process.exit(1);
  }
  
  const projectRoot = process.cwd();
  const rules = loadGuardRules(projectRoot);
  
  if (isDisabled() || rules.disabled) {
    console.log(JSON.stringify({ guardEnabled: false, message: 'Guard is disabled' }));
    process.exit(0);
  }
  
  const absTargetPath = resolve(projectRoot, targetPath);
  const workflowDir = findWorkflowDir(absTargetPath);
  
  // Output result
  const result = {
    path: targetPath,
    workflowDir,
    isWorkflowPath: !!workflowDir
  };
  
  console.log(JSON.stringify(result, null, 2));
  
  // If require-start flag and in workflow dir, check if step started
  if (requireStart && workflowDir) {
    const workflowPath = join(workflowDir, WORKFLOW_MARKER);
    const workflow = readJSON(workflowPath);
    
    if (workflow && workflow.state) {
      const currentStep = workflow.state.current_step;
      
      if (!currentStep) {
        console.error('\n⚠️ Workflow Guard: No active step. Call advance.mjs start first.');
        process.exit(2);
      }
    }
  }
  
  process.exit(0);
}

// Default: run as hook
runGuard();
