/**
 * Workflow Engine — Security Scanner
 *
 * Scans content for potential prompt injection and other security risks
 * before injecting into step instruction files.
 *
 * Inspired by hermes-agent's security scanning approach.
 *
 * Usage:
 *   import { scanContent } from './security-scanner.mjs';
 *   const result = scanContent(content);
 *   // result: { safe: boolean, warnings: string[], blocked: string[] }
 */

// ── High-Risk Patterns (block injection) ─────────────────────
// These patterns indicate likely prompt injection attempts

const HIGH_RISK_PATTERNS = [
  { name: 'ignore_instructions', pattern: /ignore\s+(all\s+)?previous\s+instructions?/i },
  { name: 'disregard_prior', pattern: /disregard\s+(all\s+)?prior/i },
  { name: 'role_override', pattern: /you\s+are\s+now\s+/i },
  { name: 'new_instructions', pattern: /new\s+instructions?:\s*/i },
  { name: 'system_prompt', pattern: /system\s*:\s*/i },
  { name: 'jailbreak', pattern: /do\s+anything\s+now/i },
  { name: 'override', pattern: /override\s+(all\s+)?(previous\s+)?instructions?/i },
];

// ── Medium-Risk Patterns (warn but allow) ────────────────────
// These patterns might be legitimate but warrant attention

const MEDIUM_RISK_PATTERNS = [
  { name: 'template_mustache', pattern: /\{\{.*\}\}/ },
  { name: 'template_erb', pattern: /<%.*%>/ },
  { name: 'template_js', pattern: /\$\{[^}]+\}/ },
  { name: 'script_tag', pattern: /<script\b/i },
  { name: 'base64_long', pattern: /[A-Za-z0-9+/]{100,}={0,2}/ },
];

// ── Public API ───────────────────────────────────────────────

/**
 * Scan content for security risks.
 *
 * @param {string} content - Content to scan
 * @returns {{ safe: boolean, warnings: string[], blocked: string[] }}
 *   - safe: true if no high-risk patterns found
 *   - warnings: medium-risk patterns detected (informational)
 *   - blocked: high-risk patterns detected (content should not be injected)
 */
export function scanContent(content) {
  if (!content || typeof content !== 'string') {
    return { safe: true, warnings: [], blocked: [] };
  }

  const warnings = [];
  const blocked = [];

  // Check high-risk patterns
  for (const { name, pattern } of HIGH_RISK_PATTERNS) {
    if (pattern.test(content)) {
      blocked.push(name);
    }
  }

  // Check medium-risk patterns
  for (const { name, pattern } of MEDIUM_RISK_PATTERNS) {
    if (pattern.test(content)) {
      warnings.push(name);
    }
  }

  return {
    safe: blocked.length === 0,
    warnings,
    blocked,
  };
}

/**
 * Format scan result for logging/output.
 *
 * @param {{ safe: boolean, warnings: string[], blocked: string[] }} result
 * @returns {string}
 */
export function formatScanResult(result) {
  if (result.safe && result.warnings.length === 0) {
    return 'Content scan passed';
  }

  const parts = [];
  if (!result.safe) {
    parts.push(`BLOCKED: ${result.blocked.join(', ')}`);
  }
  if (result.warnings.length > 0) {
    parts.push(`Warnings: ${result.warnings.join(', ')}`);
  }
  return parts.join(' | ');
}
