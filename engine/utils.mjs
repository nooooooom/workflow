/**
 * Workflow Engine — Shared Utilities
 *
 * Atomic file I/O, JSON helpers, path resolution, timestamps.
 * Zero external dependencies (Node.js built-ins only).
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, readdirSync, statSync, cpSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';

// ── JSON I/O ──────────────────────────────────────────────

/**
 * Read and parse a JSON file.
 * @param {string} filePath
 * @returns {object|null} Parsed JSON or null if file doesn't exist
 */
export function readJSON(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new Error(`Failed to read ${filePath}: ${e.message}`);
  }
}

/**
 * Write JSON to file with error handling.
 * Uses atomic write (temp file + rename) with fallback to direct write on failure.
 * Creates parent directories if needed.
 * @param {string} filePath
 * @param {object} data
 */
export function writeJSON(filePath, data) {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  
  const content = JSON.stringify(data, null, 2) + '\n';
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  
  try {
    // Try atomic write (temp file + rename)
    writeFileSync(tmpPath, content, 'utf-8');
    renameSync(tmpPath, filePath);
  } catch (e) {
    // If rename fails, try to clean up temp file
    try {
      if (existsSync(tmpPath)) {
        const { unlinkSync } = require('node:fs');
        unlinkSync(tmpPath);
      }
    } catch {}
    
    // Fallback to direct write
    writeFileSync(filePath, content, 'utf-8');
  }
}

// ── Deep Get / Set ────────────────────────────────────────

/**
 * Get a nested value by dot-path (e.g. "state.current_step").
 * @param {object} obj
 * @param {string} path
 * @returns {*}
 */
export function deepGet(obj, path) {
  return path.split('.').reduce((o, k) => (o != null ? o[k] : undefined), obj);
}

/**
 * Set a nested value by dot-path.
 * @param {object} obj
 * @param {string} path
 * @param {*} value
 */
export function deepSet(obj, path, value) {
  const keys = path.split('.');
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (current[k] == null || typeof current[k] !== 'object') {
      current[k] = {};
    }
    current = current[k];
  }
  current[keys[keys.length - 1]] = value;
}

// ── Path Helpers ──────────────────────────────────────────

/**
 * Resolve workflow directory to absolute path.
 * If given a relative path, resolves against CWD.
 * @param {string} dir
 * @returns {string}
 */
export function resolveWorkflowDir(dir) {
  return resolve(process.cwd(), dir);
}

/**
 * Get the workflow.json path for a workflow directory.
 * @param {string} dir
 * @returns {string}
 */
export function workflowPath(dir) {
  return join(resolveWorkflowDir(dir), 'workflow.json');
}

/**
 * Get the workflow root directory path.
 * Uses dirname for cross-platform compatibility.
 * @param {string} dir
 * @returns {string}
 */
export function getWorkflowRoot(dir) {
  return dirname(workflowPath(dir));
}

/**
 * Ensure a directory exists.
 * @param {string} dir
 */
export function ensureDir(dir) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// ── Timestamps ────────────────────────────────────────────

/**
 * ISO timestamp string.
 * @returns {string}
 */
export function now() {
  return new Date().toISOString();
}

// ── Hashing ───────────────────────────────────────────────

/**
 * Create a fingerprint from a string (for finding deduplication).
 * @param {string} input
 * @returns {string} First 12 chars of SHA-256
 */
export function fingerprint(input) {
  return createHash('sha256').update(input).digest('hex').slice(0, 12);
}

// ── CLI Helpers ───────────────────────────────────────────

/**
 * Parse CLI args into { command, flags }.
 * Usage: parseArgs(process.argv.slice(2))
 *
 * Example: ["init", "--dir", ".workflows/foo", "--steps", "[...]"]
 * Returns: { command: "init", flags: { dir: ".workflows/foo", steps: "[...]" } }
 *
 * @param {string[]} argv
 * @returns {{ command: string|null, flags: Record<string, string|boolean> }}
 */
export function parseArgs(argv) {
  const command = argv[0] && !argv[0].startsWith('--') ? argv[0] : null;
  const flags = {};
  const startIdx = command ? 1 : 0;

  for (let i = startIdx; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    }
  }

  return { command, flags };
}

/**
 * Print JSON to stdout (for Skill to parse).
 * @param {object} data
 */
export function output(data) {
  process.stdout.write(JSON.stringify(data) + '\n');
}

/**
 * Print error and exit with code 1.
 * @param {string} message
 */
export function fail(message) {
  output({ error: message });
  process.exit(1);
}

// ── Workflow Discovery ────────────────────────────────────

/**
 * List all workflow directories under a base path.
 * @param {string} basePath - e.g. ".workflows"
 * @returns {Array<{name: string, dir: string, status: string}>}
 */
export function listWorkflows(basePath) {
  const abs = resolve(process.cwd(), basePath);
  if (!existsSync(abs)) return [];

  return readdirSync(abs)
    .filter(name => {
      const wfPath = join(abs, name, 'workflow.json');
      return existsSync(wfPath);
    })
    .map(name => {
      const wf = readJSON(join(abs, name, 'workflow.json'));
      return {
        name: wf?.name || name,
        dir: join(basePath, name),
        description: wf?.description || '',
        status: wf?.state?.status || 'unknown',
        current_step: wf?.state?.current_step || null,
        updated_at: wf?.state?.updated_at || wf?.created_at || null,
      };
    })
    .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
}

// ── Schema Detection (v3) ────────────────────────────────────

/**
 * Detect workflow schema version.
 * v3: no history array in workflow.json
 * v2: has schema_version '2.0' and history array
 * v1: no schema_version or schema_version '1.0'
 * @param {object} wf - Workflow object
 * @returns {'v1'|'v2'|'v3'}
 */
export function detectSchema(wf) {
  // v3: no history array, state not in workflow.json
  if (!wf.history && !wf.state?.run_id) {
    return 'v3';
  }
  // v2: has schema_version '2.0'
  if (wf.schema_version === '2.0') {
    return 'v2';
  }
  // v1: no schema_version or '1.0'
  return 'v1';
}

// ── Run Instance Helpers ────────────────────────────────────

/**
 * Generate a run ID from timestamp and summary.
 * Format: run-{YYYYMMDD}-{HHMMSS}-{slug}
 * @param {string} summary - User-provided summary
 * @returns {string}
 */
export function generateRunId(summary = '') {
  const date = new Date();
  const dateStr = date.toISOString().slice(0, 10).replace(/-/g, '');
  const timeStr = date.toISOString().slice(11, 19).replace(/:/g, '');
  const slug = sanitizeRunSlug(summary);
  return `run-${dateStr}-${timeStr}${slug ? '-' + slug : ''}`;
}

/**
 * Sanitize summary for use in run ID.
 * @param {string} summary
 * @returns {string}
 */
export function sanitizeRunSlug(summary) {
  return summary
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\w\u4e00-\u9fff-]/g, '')  // keep word chars, CJK, hyphens
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30);
}

/**
 * List all run instances for a workflow.
 * @param {string} dir - Workflow directory
 * @returns {Array<{id: string, status: string, summary: string, started_at: string}>}
 */
export function listRuns(dir) {
  const wfRoot = getWorkflowRoot(dir);
  const runsDir = join(wfRoot, 'runs');

  if (!existsSync(runsDir)) {
    return [];
  }

  return readdirSync(runsDir)
    .filter(name => {
      const stat = statSync(join(runsDir, name));
      return stat.isDirectory() && name.startsWith('run-');
    })
    .map(name => {
      const statePath = join(runsDir, name, 'state.json');
      const state = readJSON(statePath);
      return {
        id: name,
        status: state?.status || 'unknown',
        summary: state?.summary || '',
        started_at: state?.started_at || null,
        updated_at: state?.updated_at || null,
      };
    })
    .sort((a, b) => (b.started_at || '').localeCompare(a.started_at || ''));
}

/**
 * Get the run directory path for a specific run.
 * @param {string} dir - Workflow directory
 * @param {string} runId - Run ID (optional, uses latest if not specified)
 * @returns {string} - Relative path like "runs/run-xxx"
 */
export function getRunDir(dir, runId = null) {
  if (runId) {
    return `runs/${runId}`;
  }
  // If no runId specified, return empty (caller should use listRuns to select)
  return '';
}

/**
 * Get absolute path to run directory.
 * @param {string} dir - Workflow directory
 * @param {string} runId - Run ID
 * @returns {string}
 */
export function getRunDirAbs(dir, runId) {
  const wfRoot = getWorkflowRoot(dir);
  return join(wfRoot, 'runs', runId);
}

/**
 * Get path to run's state.json.
 * @param {string} dir - Workflow directory
 * @param {string} runId - Run ID
 * @returns {string}
 */
export function getStatePath(dir, runId) {
  return join(getRunDirAbs(dir, runId), 'state.json');
}

/**
 * Get path to run's history.json.
 * @param {string} dir - Workflow directory
 * @param {string} runId - Run ID
 * @returns {string}
 */
export function getHistoryPath(dir, runId) {
  return join(getRunDirAbs(dir, runId), 'history.json');
}

/**
 * Get path to memory directory.
 * @param {string} dir - Workflow directory
 * @returns {string}
 */
export function getMemoryPath(dir) {
  const wfRoot = getWorkflowRoot(dir);
  return join(wfRoot, 'memory');
}

/**
 * Get path to summary-cache.json.
 * @param {string} dir - Workflow directory
 * @returns {string}
 */
export function getSummaryCachePath(dir) {
  return join(getMemoryPath(dir), 'summary-cache.json');
}

/**
 * Get path to WORKFLOW.md (curated memory file).
 * @param {string} dir - Workflow directory
 * @returns {string}
 */
export function getCuratedMemoryPath(dir, target = 'workflow') {
  const files = {
    workflow: 'WORKFLOW.md',
    memory: 'MEMORY.md',
    user: 'USER.md'
  };
  return join(getMemoryPath(dir), files[target] || files.workflow);
}

/**
 * Get path to snapshot.json for a run.
 * @param {string} dir - Workflow directory
 * @param {string} runId - Run ID
 * @returns {string}
 */
export function getSnapshotPath(dir, runId) {
  return join(getRunDirAbs(dir, runId), 'memory', 'snapshot.json');
}

/**
 * Ensure run directory structure exists.
 * Creates runs/{run-id}/artifacts, runs/{run-id}/gates, runs/{run-id}/memory
 * @param {string} dir - Workflow directory
 * @param {string} runId - Run ID
 * @returns {string} - Absolute path to run directory
 */
export function ensureRunDir(dir, runId) {
  const wfRoot = getWorkflowRoot(dir);
  const runDir = join(wfRoot, 'runs', runId);

  ensureDir(join(runDir, 'artifacts'));
  ensureDir(join(runDir, 'gates'));
  ensureDir(join(runDir, 'memory'));
  ensureDir(join(runDir, 'handoffs'));

  return runDir;
}

/**
 * Ensure memory directory exists.
 * @param {string} dir - Workflow directory
 * @returns {string} - Absolute path to memory directory
 */
export function ensureMemoryDir(dir) {
  const memoryDir = getMemoryPath(dir);
  ensureDir(memoryDir);
  return memoryDir;
}

/**
 * Migrate v1/v2 workflow to v3 schema.
 * - Moves history to runs/{run-id}/history.json
 * - Moves state to runs/{current_run}/state.json
 * - Moves memory.summary_cache to memory/summary-cache.json
 * - Removes schema_version, current_run, runs[], history[] from workflow.json
 * - Creates backup at workflow.json.v2.bak
 * @param {object} wf - Workflow object
 * @param {string} dir - Workflow directory
 * @returns {object} - Updated workflow object
 */
export function migrateToV3(wf, dir) {
  const wfRoot = getWorkflowRoot(dir);
  const wfPath = workflowPath(dir);
  const schema = detectSchema(wf);

  // Already v3
  if (schema === 'v3') {
    return wf;
  }

  // Create backup
  const backupPath = `${wfPath}.v2.bak`;
  if (!existsSync(backupPath)) {
    cpSync(wfPath, backupPath);
  }

  // Ensure memory directory
  const memoryDir = join(wfRoot, 'memory');
  ensureDir(memoryDir);

  // Migrate memory.summary_cache to memory/summary-cache.json
  if (wf.memory?.summary_cache && Object.keys(wf.memory.summary_cache).length > 0) {
    const summaryCachePath = join(memoryDir, 'summary-cache.json');
    writeJSON(summaryCachePath, wf.memory.summary_cache);
  }

  // Migrate runs
  const runsDir = join(wfRoot, 'runs');
  ensureDir(runsDir);

  if (wf.runs && wf.runs.length > 0) {
    for (const run of wf.runs) {
      const runDir = join(runsDir, run.id);
      ensureDir(join(runDir, 'artifacts'));
      ensureDir(join(runDir, 'gates'));
      ensureDir(join(runDir, 'memory'));

      // Create state.json for each run
      const statePath = join(runDir, 'state.json');
      if (!existsSync(statePath)) {
        writeJSON(statePath, {
          id: run.id,
          summary: run.summary || '',
          status: run.status || 'completed',
          current_step: null,
          completed_steps: [],
          step_states: {},
          started_at: run.started_at || now(),
          completed_at: run.completed_at || null,
          updated_at: run.completed_at || now(),
        });
      }

      // Create empty history.json
      const historyPath = join(runDir, 'history.json');
      if (!existsSync(historyPath)) {
        writeJSON(historyPath, []);
      }
    }
  }

  // Migrate current_run state
  if (wf.current_run && wf.state) {
    const currentRunDir = join(runsDir, wf.current_run);
    ensureDir(join(currentRunDir, 'artifacts'));
    ensureDir(join(currentRunDir, 'gates'));
    ensureDir(join(currentRunDir, 'memory'));

    const statePath = join(currentRunDir, 'state.json');
    writeJSON(statePath, {
      id: wf.current_run,
      summary: wf.runs?.find(r => r.id === wf.current_run)?.summary || '',
      status: wf.state.status || 'ready',
      current_step: wf.state.current_step || null,
      completed_steps: wf.state.completed_steps || [],
      step_states: wf.state.step_states || {},
      started_at: wf.runs?.find(r => r.id === wf.current_run)?.started_at || now(),
      completed_at: null,
      updated_at: wf.state.updated_at || now(),
    });

    // Migrate history
    if (wf.history && wf.history.length > 0) {
      const historyPath = join(currentRunDir, 'history.json');
      writeJSON(historyPath, wf.history);
    }
  }

  // Clean up workflow.json - remove v2 fields
  const v3Wf = {
    name: wf.name,
    description: wf.description || '',
    created_at: wf.created_at,
    steps: wf.steps,
    hooks: wf.hooks || { on_step_start: [], on_step_complete: [], on_gate_pass: [], on_gate_fail: [], on_workflow_complete: [], on_loop_start: [], on_loop_exit: [] },
    message_bus: wf.message_bus || { messages: [], agents: {} },
    evolution: wf.evolution || { enabled: true, max_lessons_per_step: 5, last_extracted: null, lessons_file: null, last_injected: null },
  };

  // Save updated workflow.json
  writeJSON(wfPath, v3Wf);

  return v3Wf;
}

// Legacy function for backward compatibility
export function migrateToV2(wf, dir) {
  return migrateToV3(wf, dir);
}

// ── Artifact Helpers ─────────────────────────────────────

/**
 * Resolve artifact configuration from step definition.
 * Returns normalized { type, path } regardless of schema format.
 *
 * @param {object|string|null} artifact - Step's artifact field
 * @param {number} stepId - Step ID (for fallback path generation)
 * @returns {{ type: 'content'|'reference', path: string }}
 */
export function resolveArtifact(artifact, stepId) {
  // Explicit null means "no artifact" (handoff-only mode)
  if (artifact === null) {
    return { type: 'none', path: null };
  }
  // Undefined or empty string: fall back to default path
  if (!artifact) {
    return {
      type: 'content',
      path: `artifacts/${String(stepId).padStart(2, '0')}-step.md`,
    };
  }
  if (typeof artifact === 'string') {
    return { type: 'content', path: artifact };
  }
  if (artifact.type === 'reference') {
    return {
      type: 'reference',
      path: artifact.manifest || `artifacts/${String(stepId).padStart(2, '0')}-step.md`,
    };
  }
  // Unknown object format — treat as content
  return {
    type: 'content',
    path: artifact.path || artifact.manifest || `artifacts/${String(stepId).padStart(2, '0')}-step.md`,
  };
}

/**
 * Parse a reference artifact manifest and extract file entries.
 *
 * Expected format:
 *   ## Summary
 *   Brief description...
 *
 *   ## Files
 *   | Action | Path | Description |
 *   |--------|------|-------------|
 *   | created | src/foo.ts | ... |
 *
 *   ## Notes
 *   Optional extra context...
 *
 * @param {string} content - Manifest markdown content
 * @returns {{ summary: string, files: Array<{action: string, path: string, description: string}>, notes: string|null }}
 */
export function parseManifest(content) {
  const lines = content.split('\n');
  const result = { summary: '', files: [], notes: null };

  let section = null;
  const summaryLines = [];
  const notesLines = [];
  let inTable = false;

  for (const line of lines) {
    if (line.startsWith('## Summary')) { section = 'summary'; continue; }
    if (line.startsWith('## Files'))   { section = 'files'; inTable = false; continue; }
    if (line.startsWith('## Notes'))   { section = 'notes'; continue; }
    if (line.startsWith('## '))        { section = null; continue; }

    if (section === 'summary') {
      if (line.trim()) summaryLines.push(line.trim());
    }

    if (section === 'files') {
      if (line.includes('Action') && line.includes('Path')) continue;   // header
      if (/^\|[-\s|]+\|$/.test(line)) { inTable = true; continue; }    // separator

      if (inTable && line.startsWith('|')) {
        const cols = line.split('|').map(c => c.trim()).filter(c => c);
        if (cols.length >= 3) {
          result.files.push({
            action: cols[0],
            path: cols[1],
            description: cols[2],
          });
        }
      }
    }

    if (section === 'notes') {
      if (line.trim()) notesLines.push(line.trim());
    }
  }

  result.summary = summaryLines.join(' ');
  result.notes = notesLines.length > 0 ? notesLines.join('\n') : null;
  return result;
}

// Legacy functions for backward compatibility
export function getRunDirLegacy(wf, dir) {
  // v1 format: no schema_version or schema_version === '1.0'
  if (!wf.schema_version || wf.schema_version === '1.0') {
    return '';
  }
  // v2 format: use runs/{run-id}
  const runId = wf.current_run;
  if (!runId) return '';
  return `runs/${runId}`;
}

export function getRunDirAbsLegacy(wf, dir) {
  const runDir = getRunDirLegacy(wf, dir);
  const wfRoot = getWorkflowRoot(dir);
  return runDir ? join(wfRoot, runDir) : wfRoot;
}
