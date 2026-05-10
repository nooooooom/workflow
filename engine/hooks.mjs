/**
 * Workflow Engine — Lifecycle Hook Dispatcher
 *
 * Runs user-registered commands on workflow events.
 * Hooks are non-blocking: failures are logged but don't halt the workflow.
 *
 * Commands:
 *   emit  --dir <path> --run <run-id> --event <name> [--data <json>]   Fire an event
 *   list  --dir <path>                                                 List registered hooks
 *   add   --dir <path> --event <name> --command <cmd>                  Register a hook
 *   remove --dir <path> --event <name> --command <cmd>                 Unregister a hook
 *
 * Events:
 *   on_step_start, on_step_complete, on_gate_pass, on_gate_fail,
 *   on_workflow_complete, on_loop_start, on_loop_exit
 */

import {
  readJSON, writeJSON, workflowPath, getWorkflowRoot,
  now, parseArgs, output, fail,
  getHistoryPath, detectSchema,
} from './utils.mjs';
import { execSync } from 'node:child_process';

const VALID_EVENTS = [
  'on_step_start',
  'on_step_complete',
  'on_gate_pass',
  'on_gate_fail',
  'on_workflow_complete',
  'on_loop_start',
  'on_loop_exit',
];

// ── Helpers ───────────────────────────────────────────────

function loadWorkflow(dir) {
  const wf = readJSON(workflowPath(dir));
  if (!wf) fail(`No workflow found at ${dir}`);
  return wf;
}

function saveWorkflow(dir, wf) {
  writeJSON(workflowPath(dir), wf);
}

function validateEvent(event) {
  if (!VALID_EVENTS.includes(event)) {
    fail(`Invalid event: ${event}. Valid: ${VALID_EVENTS.join(', ')}`);
  }
}

// ── Commands ──────────────────────────────────────────────

function emit(flags) {
  const { dir, run: runId, event, data: dataRaw } = flags;
  if (!dir) fail('--dir is required');
  if (!event) fail('--event is required');
  validateEvent(event);

  const wf = loadWorkflow(dir);
  const hooks = wf.hooks?.[event] || [];

  let eventData = {};
  if (dataRaw) {
    try {
      eventData = JSON.parse(dataRaw);
    } catch {
      eventData = { raw: dataRaw };
    }
  }

  const results = [];
  const wfRoot = getWorkflowRoot(dir);

  for (const cmd of hooks) {
    try {
      const stdout = execSync(cmd, {
        cwd: wfRoot,
        encoding: 'utf-8',
        timeout: 30000,
        env: {
          ...process.env,
          WORKFLOW_EVENT: event,
          WORKFLOW_DIR: wfRoot,
          WORKFLOW_NAME: wf.name,
          RUN_ID: runId || '',
          EVENT_DATA: JSON.stringify(eventData),
        },
      });
      results.push({ command: cmd, status: 'ok', stdout: stdout.trim() });
    } catch (e) {
      results.push({
        command: cmd,
        status: 'error',
        error: e.message,
        stderr: e.stderr?.toString().trim() || '',
      });
    }
  }

  // Log to history (v3: in run directory)
  if (runId) {
    const historyPath = getHistoryPath(dir, runId);
    const history = readJSON(historyPath) || [];
    history.push({
      event: `hook:${event}`,
      hooks_run: results.length,
      hooks_failed: results.filter(r => r.status === 'error').length,
      at: now(),
    });
    writeJSON(historyPath, history);
  }

  output({
    ok: true,
    event,
    hooks_run: results.length,
    results,
  });
}

function list(flags) {
  const { dir } = flags;
  if (!dir) fail('--dir is required');

  const wf = loadWorkflow(dir);
  const hooks = wf.hooks || {};

  const summary = {};
  for (const event of VALID_EVENTS) {
    summary[event] = hooks[event] || [];
  }

  output({ ok: true, hooks: summary });
}

function add(flags) {
  const { dir, event, command: cmd } = flags;
  if (!dir) fail('--dir is required');
  if (!event) fail('--event is required');
  if (!cmd) fail('--command is required');
  validateEvent(event);

  const wf = loadWorkflow(dir);
  if (!wf.hooks) wf.hooks = {};
  if (!wf.hooks[event]) wf.hooks[event] = [];

  if (wf.hooks[event].includes(cmd)) {
    output({ ok: true, message: 'Hook already registered', event, command: cmd });
    return;
  }

  wf.hooks[event].push(cmd);
  saveWorkflow(dir, wf);

  output({ ok: true, event, command: cmd, message: 'Hook registered' });
}

function remove(flags) {
  const { dir, event, command: cmd } = flags;
  if (!dir) fail('--dir is required');
  if (!event) fail('--event is required');
  if (!cmd) fail('--command is required');
  validateEvent(event);

  const wf = loadWorkflow(dir);
  if (!wf.hooks?.[event]) {
    output({ ok: true, message: 'No hooks registered for this event' });
    return;
  }

  const idx = wf.hooks[event].indexOf(cmd);
  if (idx === -1) {
    output({ ok: true, message: 'Hook not found' });
    return;
  }

  wf.hooks[event].splice(idx, 1);
  saveWorkflow(dir, wf);

  output({ ok: true, event, command: cmd, message: 'Hook removed' });
}

// ── Main ──────────────────────────────────────────────────

const { command: cmd, flags } = parseArgs(process.argv.slice(2));

switch (cmd) {
  case 'emit':   emit(flags); break;
  case 'list':   list(flags); break;
  case 'add':    add(flags); break;
  case 'remove': remove(flags); break;
  default:       fail(`Unknown command: ${cmd}. Use emit|list|add|remove`);
}
