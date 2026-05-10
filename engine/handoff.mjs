/**
 * Workflow Engine — Handoff System
 *
 * Generates structured context transfer documents between steps,
 * solving the sliding-window memory loss problem in long workflows.
 *
 * Three modes:
 *   inter    — Step-to-step context transfer (default, auto-triggered)
 *   fire     — Self-contained doc for external Claude sessions (Fire-and-Forget)
 *   subagent — Delegation doc with callback path for subagent execution
 *
 * Commands:
 *   generate  --dir <path> --run <id> --step <id> [--mode inter|fire|subagent] [--context '{json}']
 *   load      --dir <path> --run <id> --step <id>
 *   list      --dir <path> --run <id>
 *   preview   --dir <path> --run <id> --step <id> [--mode fire|subagent]
 *
 * Storage: runs/{run-id}/handoffs/
 */

import {
  readJSON, writeJSON, getWorkflowRoot, workflowPath,
  now, parseArgs, output, fail, ensureDir,
  getStatePath, getRunDirAbs, getSummaryCachePath,
  getCuratedMemoryPath, resolveArtifact, parseManifest,
  listRuns, detectSchema, migrateToV3,
} from './utils.mjs';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const HANDOFF_VERSION = '1.0';
const MAX_FIRE_ARTIFACT_CHARS = 10000;
const MAX_ONE_LINER_CHARS = 120;

// ── Helpers ───────────────────────────────────────────────

function loadWorkflow(dir) {
  let wf = readJSON(workflowPath(dir));
  if (!wf) fail(`No workflow found at ${dir}`);
  const schema = detectSchema(wf);
  if (schema !== 'v3') {
    wf = migrateToV3(wf, dir);
  }
  return wf;
}

function loadState(dir, runId) {
  if (!runId) fail('--run is required');
  const state = readJSON(getStatePath(dir, runId));
  if (!state) fail(`Run "${runId}" not found`);
  return state;
}

function getStep(wf, stepId) {
  const id = Number(stepId);
  return wf.steps.find(s => s.id === id);
}

function resolveRunId(dir, flagRunId) {
  if (flagRunId) return flagRunId;
  const runs = listRuns(dir);
  if (runs.length === 1) return runs[0].id;
  if (runs.length === 0) fail('No run instances found.');
  output({
    ok: false,
    error: 'multiple_runs',
    message: 'Multiple run instances found. Please specify --run.',
    runs: runs.map(r => ({ id: r.id, status: r.status, summary: r.summary })),
  });
  process.exit(0);
}

function getHandoffDir(dir, runId) {
  return join(getRunDirAbs(dir, runId), 'handoffs');
}

function readFile(filePath) {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

// ── Summary Collectors ──────────────────────────────────────

/**
 * Build one-liner summary for a completed step.
 * Tries structured_summary > summary-cache > extractFromArtifact.
 */
function getStepOneLiner(dir, runId, stepId, wf, state) {
  const step = getStep(wf, stepId);
  if (!step) return `Step ${stepId} (unknown)`;

  const stepState = state.step_states[stepId] || {};

  // 1. Structured summary (best quality)
  const structured = stepState.structured_summary;
  if (structured?.active_task) {
    const actions = (structured.completed_actions || []).slice(0, 2).join('; ');
    const liner = actions ? `${structured.active_task}: ${actions}` : structured.active_task;
    return liner.slice(0, MAX_ONE_LINER_CHARS);
  }

  // 2. Summary cache
  const summaryCache = readJSON(getSummaryCachePath(dir)) || {};
  const cached = summaryCache[stepId];
  if (cached?.summary) {
    return cached.summary.slice(0, MAX_ONE_LINER_CHARS);
  }

  // 3. State summary
  if (stepState.summary) {
    return stepState.summary.slice(0, MAX_ONE_LINER_CHARS);
  }

  // 4. Extract from artifact (skip for null artifact steps)
  const resolved = resolveArtifact(step.artifact, stepId);
  if (resolved.type === 'none') return `${step.name} completed`;
  const wfRoot = getWorkflowRoot(dir);
  const artifactPath = join(wfRoot, 'runs', runId, resolved.path);
  const content = readFile(artifactPath);
  if (content) {
    if (resolved.type === 'reference') {
      const manifest = parseManifest(content);
      if (manifest.summary) return manifest.summary.slice(0, MAX_ONE_LINER_CHARS);
    }
    // Take first meaningful line
    const lines = content.split('\n').filter(l =>
      !l.startsWith('#') && !l.startsWith('---') && !l.startsWith('|') && l.trim().length > 15
    );
    if (lines.length > 0) return lines[0].trim().slice(0, MAX_ONE_LINER_CHARS);
  }

  return `${step.name} completed`;
}

/**
 * Collect key decisions from step's artifact and gate results.
 */
function collectKeyDecisions(dir, runId, stepId, wf) {
  const step = getStep(wf, stepId);
  if (!step) return [];

  const decisions = [];

  // From state
  const state = loadState(dir, runId);
  const stepState = state.step_states[stepId] || {};
  if (stepState.key_decisions) {
    decisions.push(...stepState.key_decisions);
  }

  // From summary cache
  const summaryCache = readJSON(getSummaryCachePath(dir)) || {};
  const cached = summaryCache[stepId];
  if (cached?.key_decisions) {
    for (const d of cached.key_decisions) {
      if (!decisions.includes(d)) decisions.push(d);
    }
  }

  // From artifact content (regex extraction) — skip for null artifact steps
  const resolved = resolveArtifact(step.artifact, stepId);
  if (resolved.type === 'none') return decisions.slice(0, 10);
  const wfRoot = getWorkflowRoot(dir);
  const artifactPath = join(wfRoot, 'runs', runId, resolved.path);
  const content = readFile(artifactPath);
  if (content) {
    const patterns = [
      /决定[：:]\s*(.+)/g,
      /决策[：:]\s*(.+)/g,
      /选择了?\s*(.{10,80})/g,
      /Decision[：:]\s*(.+)/gi,
    ];
    for (const pat of patterns) {
      let m;
      while ((m = pat.exec(content)) !== null && decisions.length < 10) {
        const d = m[1].trim().slice(0, 100);
        if (d && !decisions.includes(d)) decisions.push(d);
      }
    }
  }

  return decisions.slice(0, 10);
}

/**
 * Read artifact content for a step. For reference type, returns parsed manifest info.
 */
function getArtifactInfo(dir, runId, stepId, wf) {
  const step = getStep(wf, stepId);
  if (!step) return null;

  const resolved = resolveArtifact(step.artifact, stepId);

  // No artifact (handoff-only step)
  if (resolved.type === 'none') {
    return { type: 'none', path: null, exists: false };
  }

  const wfRoot = getWorkflowRoot(dir);
  const artifactPath = join(wfRoot, 'runs', runId, resolved.path);
  const content = readFile(artifactPath);

  if (!content) {
    return { type: resolved.type, path: resolved.path, exists: false };
  }

  if (resolved.type === 'reference') {
    const manifest = parseManifest(content);
    return {
      type: 'reference',
      path: resolved.path,
      exists: true,
      summary: manifest.summary,
      files: manifest.files,
      notes: manifest.notes,
    };
  }

  return {
    type: 'content',
    path: resolved.path,
    exists: true,
    content_length: content.length,
    preview: content.slice(0, 500),
  };
}

/**
 * Load curated memory entries (WORKFLOW.md + MEMORY.md).
 */
function loadCuratedMemory(dir) {
  const entries = {};
  for (const target of ['workflow', 'memory', 'user']) {
    const filePath = getCuratedMemoryPath(dir, target);
    if (existsSync(filePath)) {
      const raw = readFileSync(filePath, 'utf-8');
      // Parse § separated entries, skip header
      const lines = raw.split('\n');
      const bodyStart = lines.findIndex(l => l.startsWith('══')) + 1;
      if (bodyStart > 0) {
        const body = lines.slice(bodyStart).join('\n').trim();
        if (body) {
          entries[target] = body.split('§').map(e => e.trim()).filter(Boolean);
        }
      }
    }
  }
  return entries;
}

/**
 * Read gate result for a step.
 */
function loadGateResult(dir, runId, step) {
  const wfRoot = getWorkflowRoot(dir);
  const gatePath = join(wfRoot, 'runs', runId, 'gates',
    `${String(step.id).padStart(2, '0')}-${step.name}-gate.json`);
  return readJSON(gatePath);
}

/**
 * Read a step instruction file and extract hints about what context the step needs.
 */
function extractInstructionNeeds(dir, step) {
  if (!step.instruction) return null;
  const wfRoot = getWorkflowRoot(dir);
  const instrPath = join(wfRoot, step.instruction);
  const content = readFile(instrPath);
  if (!content) return null;

  // Return the instruction content for the receiver to understand their task
  return {
    path: step.instruction,
    preview: content.slice(0, 800),
  };
}

// ── Handoff Builders ───────────────────────────────────────

/**
 * Build inter-step handoff document.
 */
function buildInterHandoff(dir, runId, step, wf, state, nextStep) {
  // Collect all completed steps summaries (NOT limited to 3-step window)
  const completedIds = state.completed_steps || [];
  const completedStepsSummary = completedIds.map(id => ({
    id,
    name: getStep(wf, id)?.name || `step-${id}`,
    one_liner: getStepOneLiner(dir, runId, id, wf, state),
  }));

  // Current step artifact info
  const artifactInfo = getArtifactInfo(dir, runId, step.id, wf);

  // Key decisions from current step
  const keyDecisions = collectKeyDecisions(dir, runId, step.id, wf);

  // Gate result summary
  const gateResult = loadGateResult(dir, runId, step);
  const gateInfo = gateResult ? {
    result: gateResult.result,
    score: gateResult.score || null,
    findings_count: (gateResult.findings || []).length,
    key_findings: (gateResult.findings || [])
      .filter(f => f.severity === 'critical' || f.severity === 'high')
      .map(f => ({ severity: f.severity, title: f.title })),
  } : null;

  // Curated memory snapshot
  const curatedMemory = loadCuratedMemory(dir);

  // Next step instruction preview
  const nextStepNeeds = nextStep ? extractInstructionNeeds(dir, nextStep) : null;

  return {
    handoff_version: HANDOFF_VERSION,
    mode: 'inter',
    generated_at: now(),

    from_step: {
      id: step.id,
      name: step.name,
      completed_at: state.step_states[step.id]?.completed_at || now(),
    },

    to_step: nextStep ? {
      id: nextStep.id,
      name: nextStep.name,
      instruction: nextStep.instruction,
      instruction_preview: nextStepNeeds?.preview || null,
    } : null,

    workflow_context: {
      name: wf.name,
      description: wf.description || '',
      progress: `${completedIds.length}/${wf.steps.length} steps completed`,
      completed_steps_summary: completedStepsSummary,
    },

    what_was_done: {
      summary: getStepOneLiner(dir, runId, step.id, wf, state),
      artifact: artifactInfo,
      gate: gateInfo,
    },

    key_decisions: keyDecisions,

    // These fields are auto-extracted but can be supplemented via --save
    critical_context_for_next_step: [],
    open_questions: [],
    remaining_work: state.step_states[step.id]?.structured_summary?.remaining_work || null,

    curated_memory: curatedMemory,
  };
}

/**
 * Build fire-and-forget handoff (self-contained for external session).
 */
function buildFireHandoff(dir, runId, step, wf, state) {
  // Start with inter handoff as base
  const base = buildInterHandoff(dir, runId, step, wf, state, null);
  base.mode = 'fire';

  // Find next step
  const completedIds = state.completed_steps || [];
  const nextStep = wf.steps.find(s => {
    const st = state.step_states[s.id];
    const isPending = !st || st.status === 'pending';
    const depsMet = (s.dependsOn || []).every(depId => {
      const depState = state.step_states[depId];
      return depState?.status === 'completed';
    });
    return isPending && depsMet;
  });

  if (nextStep) {
    base.to_step = {
      id: nextStep.id,
      name: nextStep.name,
      instruction: nextStep.instruction,
      instruction_preview: extractInstructionNeeds(dir, nextStep)?.preview || null,
    };
  }

  // Full artifact content (for self-containment)
  const resolved = resolveArtifact(step.artifact, step.id);
  const wfRoot = getWorkflowRoot(dir);
  const artifactPath = join(wfRoot, 'runs', runId, resolved.path);
  let fullArtifactContent = readFile(artifactPath) || '';
  if (fullArtifactContent.length > MAX_FIRE_ARTIFACT_CHARS) {
    fullArtifactContent = fullArtifactContent.slice(0, MAX_FIRE_ARTIFACT_CHARS)
      + `\n\n... [truncated at ${MAX_FIRE_ARTIFACT_CHARS} chars, full content at ${resolved.path}]`;
  }

  // All step summaries with more detail
  const allStepSummaries = {};
  for (const s of wf.steps) {
    const st = state.step_states[s.id];
    if (st?.status === 'completed') {
      allStepSummaries[s.id] = {
        name: s.name,
        status: 'completed',
        summary: getStepOneLiner(dir, runId, s.id, wf, state),
        key_decisions: collectKeyDecisions(dir, runId, s.id, wf),
        artifact_path: resolveArtifact(s.artifact, s.id).path,
      };
    }
  }

  base.self_contained = {
    workflow_definition: {
      name: wf.name,
      description: wf.description || '',
      total_steps: wf.steps.length,
      steps: wf.steps.map(s => ({
        id: s.id,
        name: s.name,
        status: state.step_states[s.id]?.status || 'pending',
        dependsOn: s.dependsOn || [],
      })),
    },
    full_artifact_content: fullArtifactContent,
    all_step_summaries: allStepSummaries,
    instructions_for_receiver: [
      `你正在接手一个进行中的工作流：「${wf.name}」`,
      `当前已完成 ${completedIds.length}/${wf.steps.length} 步`,
      `最后完成的步骤是 Step ${step.id}（${step.name}）`,
      nextStep
        ? `下一步是 Step ${nextStep.id}（${nextStep.name}），指令文件在 ${nextStep.instruction}`
        : '所有步骤已完成',
      '请阅读 workflow_context.completed_steps_summary 了解完整进度',
      '请阅读 key_decisions 了解已做出的关键决策',
      '请阅读 critical_context_for_next_step 了解需要注意的事项',
    ],
  };

  return base;
}

/**
 * Build subagent handoff (delegation with callback).
 */
function buildSubagentHandoff(dir, runId, step, wf, state, extraContext) {
  const base = buildInterHandoff(dir, runId, step, wf, state, null);
  base.mode = 'subagent';

  // Parse extra context
  let delegationConfig = {};
  if (extraContext) {
    try {
      delegationConfig = JSON.parse(extraContext);
    } catch {
      delegationConfig = { task_description: extraContext };
    }
  }

  // Find target step for callback
  const targetStepId = delegationConfig.target_step || null;
  const targetStep = targetStepId ? getStep(wf, targetStepId) : null;
  const resolved = targetStep
    ? resolveArtifact(targetStep.artifact, targetStep.id)
    : null;

  base.delegation = {
    task_description: delegationConfig.task_description || `Execute step: ${step.name}`,
    scope: delegationConfig.scope || {},
    constraints: delegationConfig.constraints || [],
    callback: {
      type: 'artifact_write',
      workflow_dir: dir,
      run_id: runId,
      step_id: targetStepId || step.id,
      artifact_path: resolved
        ? `runs/${runId}/${resolved.path}`
        : null,
      artifact_type: resolved?.type || 'content',
      report_format: resolved?.type === 'reference' ? 'manifest' : 'markdown',
    },
    timeout_minutes: delegationConfig.timeout_minutes || 30,
    on_completion: `After writing the artifact, the parent orchestrator will call: node engine/advance.mjs complete --dir "${dir}" --run "${runId}" --step ${targetStepId || step.id}`,
  };

  return base;
}

// ── Index Management ──────────────────────────────────────

function loadIndex(dir, runId) {
  const indexPath = join(getHandoffDir(dir, runId), 'index.json');
  return readJSON(indexPath) || { handoffs: [] };
}

function saveIndex(dir, runId, index) {
  const indexPath = join(getHandoffDir(dir, runId), 'index.json');
  writeJSON(indexPath, index);
}

function addToIndex(dir, runId, entry) {
  const index = loadIndex(dir, runId);
  // Deduplicate by file name
  index.handoffs = index.handoffs.filter(h => h.file !== entry.file);
  index.handoffs.push(entry);
  saveIndex(dir, runId, index);
}

// ── Commands ──────────────────────────────────────────────

function generate(flags) {
  const { dir, step: stepId, mode: modeFlag, context: extraContext, save: saveData } = flags;
  if (!dir) fail('--dir is required');
  if (!stepId) fail('--step is required');

  const runId = resolveRunId(dir, flags.run);
  const wf = loadWorkflow(dir);
  const state = loadState(dir, runId);
  const step = getStep(wf, Number(stepId));
  if (!step) fail(`Step ${stepId} not found`);

  const mode = modeFlag || 'inter';
  const handoffDir = getHandoffDir(dir, runId);
  ensureDir(handoffDir);

  // If --save is provided, merge into existing handoff
  if (saveData) {
    const existingFiles = readdirSync(handoffDir).filter(f => f.includes(`step-${String(step.id).padStart(2, '0')}`));
    if (existingFiles.length > 0) {
      const existingPath = join(handoffDir, existingFiles[existingFiles.length - 1]);
      const existing = readJSON(existingPath);
      if (existing) {
        let supplement;
        try {
          supplement = JSON.parse(saveData);
        } catch {
          fail('--save must be valid JSON');
        }

        // Merge supplemental data
        if (supplement.critical_context_for_next_step) {
          existing.critical_context_for_next_step = [
            ...(existing.critical_context_for_next_step || []),
            ...supplement.critical_context_for_next_step,
          ];
        }
        if (supplement.open_questions) {
          existing.open_questions = [
            ...(existing.open_questions || []),
            ...supplement.open_questions,
          ];
        }
        if (supplement.key_decisions) {
          existing.key_decisions = [
            ...(existing.key_decisions || []),
            ...supplement.key_decisions,
          ];
        }
        if (supplement.remaining_work !== undefined) {
          existing.remaining_work = supplement.remaining_work;
        }

        existing.supplemented_at = now();
        existing.auto_only = false;
        writeJSON(existingPath, existing);

        output({
          ok: true,
          action: 'supplemented',
          file: existingPath,
          fields_updated: Object.keys(supplement),
        });
        return;
      }
    }
    fail(`No existing handoff found for step ${stepId} to supplement`);
  }

  // Find next step for inter mode
  let nextStep = null;
  if (mode === 'inter') {
    const completedIds = state.completed_steps || [];
    nextStep = wf.steps.find(s => {
      const st = state.step_states[s.id];
      const isPending = !st || st.status === 'pending';
      const depsMet = (s.dependsOn || []).every(depId => {
        const depState = state.step_states[depId];
        return depState?.status === 'completed';
      });
      return isPending && depsMet;
    });
  }

  // Build handoff based on mode
  let handoff;
  switch (mode) {
    case 'inter':
      handoff = buildInterHandoff(dir, runId, step, wf, state, nextStep);
      break;
    case 'fire':
      handoff = buildFireHandoff(dir, runId, step, wf, state);
      break;
    case 'subagent':
      handoff = buildSubagentHandoff(dir, runId, step, wf, state, extraContext);
      break;
    default:
      fail(`Unknown mode: ${mode}. Use inter|fire|subagent`);
  }

  handoff.auto_only = true; // Mark as auto-generated, can be supplemented

  // Determine file name
  const stepPad = String(step.id).padStart(2, '0');
  let fileName;
  switch (mode) {
    case 'inter': {
      const toPad = nextStep ? String(nextStep.id).padStart(2, '0') : 'end';
      fileName = `from-step-${stepPad}-to-step-${toPad}.json`;
      break;
    }
    case 'fire':
      fileName = `fire-step-${stepPad}.json`;
      break;
    case 'subagent':
      fileName = `subagent-step-${stepPad}-${Date.now()}.json`;
      break;
  }

  const filePath = join(handoffDir, fileName);
  writeJSON(filePath, handoff);

  // Update index
  addToIndex(dir, runId, {
    from_step: step.id,
    to_step: nextStep?.id || null,
    mode,
    file: fileName,
    generated_at: handoff.generated_at,
  });

  output({
    ok: true,
    action: 'generated',
    mode,
    file: filePath,
    from_step: step.id,
    to_step: nextStep?.id || null,
    summary: {
      completed_steps_count: handoff.workflow_context.completed_steps_summary.length,
      key_decisions_count: handoff.key_decisions.length,
      has_artifact: handoff.what_was_done.artifact?.exists || false,
    },
    hint: 'Use --save to supplement with critical_context_for_next_step and open_questions',
  });
}

function load(flags) {
  const { dir, step: stepId } = flags;
  if (!dir) fail('--dir is required');
  if (!stepId) fail('--step is required');

  const runId = resolveRunId(dir, flags.run);
  const handoffDir = getHandoffDir(dir, runId);

  if (!existsSync(handoffDir)) {
    output({ ok: true, handoff: null, message: 'No handoffs directory. Use compact context as fallback.' });
    return;
  }

  // Look for handoff targeting this step
  const targetPad = String(Number(stepId)).padStart(2, '0');
  const files = readdirSync(handoffDir).filter(f =>
    f.endsWith('.json') && f !== 'index.json'
  );

  // Priority 1: direct "to-step-{id}" match
  const directMatch = files.find(f => f.includes(`to-step-${targetPad}`));
  if (directMatch) {
    const handoff = readJSON(join(handoffDir, directMatch));
    output({
      ok: true,
      handoff,
      source: directMatch,
      message: 'Inbound handoff loaded. Use critical_context_for_next_step for key context.',
    });
    return;
  }

  // Priority 2: find the latest handoff from the previous step
  const wf = loadWorkflow(dir);
  const step = getStep(wf, Number(stepId));
  if (step) {
    const deps = step.dependsOn || [];
    for (const depId of deps) {
      const depPad = String(depId).padStart(2, '0');
      const depMatch = files.find(f => f.startsWith(`from-step-${depPad}`));
      if (depMatch) {
        const handoff = readJSON(join(handoffDir, depMatch));
        output({
          ok: true,
          handoff,
          source: depMatch,
          match_type: 'dependency',
          message: `Loaded handoff from dependency step ${depId}.`,
        });
        return;
      }
    }
  }

  // Priority 3: latest inter handoff as general context
  const interHandoffs = files
    .filter(f => f.startsWith('from-step-'))
    .sort()
    .reverse();

  if (interHandoffs.length > 0) {
    const handoff = readJSON(join(handoffDir, interHandoffs[0]));
    output({
      ok: true,
      handoff,
      source: interHandoffs[0],
      match_type: 'latest',
      message: 'No direct match. Loaded latest available handoff as general context.',
    });
    return;
  }

  output({
    ok: true,
    handoff: null,
    message: 'No handoffs found. Use compact context as fallback.',
  });
}

function list(flags) {
  const { dir } = flags;
  if (!dir) fail('--dir is required');

  const runId = resolveRunId(dir, flags.run);
  const index = loadIndex(dir, runId);

  output({
    ok: true,
    run_id: runId,
    count: index.handoffs.length,
    handoffs: index.handoffs,
  });
}

function preview(flags) {
  const { dir, step: stepId, mode: modeFlag, context: extraContext } = flags;
  if (!dir) fail('--dir is required');
  if (!stepId) fail('--step is required');

  const runId = resolveRunId(dir, flags.run);
  const wf = loadWorkflow(dir);
  const state = loadState(dir, runId);
  const step = getStep(wf, Number(stepId));
  if (!step) fail(`Step ${stepId} not found`);

  const mode = modeFlag || 'inter';

  let handoff;
  switch (mode) {
    case 'inter': {
      const nextStep = wf.steps.find(s => {
        const st = state.step_states[s.id];
        const isPending = !st || st.status === 'pending';
        const depsMet = (s.dependsOn || []).every(depId => {
          const depState = state.step_states[depId];
          return depState?.status === 'completed';
        });
        return isPending && depsMet;
      });
      handoff = buildInterHandoff(dir, runId, step, wf, state, nextStep);
      break;
    }
    case 'fire':
      handoff = buildFireHandoff(dir, runId, step, wf, state);
      break;
    case 'subagent':
      handoff = buildSubagentHandoff(dir, runId, step, wf, state, extraContext);
      break;
    default:
      fail(`Unknown mode: ${mode}`);
  }

  output({
    ok: true,
    preview: true,
    mode,
    handoff,
  });
}

// ── Main ──────────────────────────────────────────────────

const { command, flags } = parseArgs(process.argv.slice(2));

switch (command) {
  case 'generate': generate(flags); break;
  case 'load':     load(flags); break;
  case 'list':     list(flags); break;
  case 'preview':  preview(flags); break;
  default:         fail(`Unknown command: ${command}. Use generate|load|list|preview`);
}
