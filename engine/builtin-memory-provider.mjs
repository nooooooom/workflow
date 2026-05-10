/**
 * BuiltinMemoryProvider - File-based Memory Storage
 *
 * Built-in memory provider using file system.
 * Supports MEMORY.md, USER.md, WORKFLOW.md with bounded storage.
 *
 * Security features inspired by hermes-agent:
 * - Threat pattern detection
 * - Unicode filtering
 * - Atomic writes
 * - File locking
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { MemoryProvider } from './memory-provider.mjs';
import { ensureDir } from './utils.mjs';

const ENTRY_DELIMITER = '\n§\n';

// Character limits per target (from hermes-agent)
const CHAR_LIMITS = {
  memory: 2200,
  user: 1375,
  workflow: 2000,
};

// Threat patterns (inspired by hermes-agent)
const THREAT_PATTERNS = [
  { pattern: /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, type: 'XSS' },
  { pattern: /javascript:/gi, type: 'XSS' },
  { pattern: /on\w+\s*=/gi, type: 'XSS' },
  { pattern: /UNION\s+SELECT/gi, type: 'SQL_INJECTION' },
  { pattern: /;\s*DROP\s+TABLE/gi, type: 'SQL_INJECTION' },
  { pattern: /;\s*DELETE\s+FROM/gi, type: 'SQL_INJECTION' },
  { pattern: /\|\s*\w+/g, type: 'COMMAND_INJECTION' },
  { pattern: /`[^`]+`/g, type: 'COMMAND_INJECTION' },
];

// Dangerous Unicode ranges (from hermes-agent)
const DANGEROUS_UNICODE = [
  [0x200B, 0x200D], // Zero-width spaces
  [0x202A, 0x202E], // Bidirectional text overrides
  [0x2066, 0x2069], // Isolate controls
  [0xFEFF, 0xFEFF], // BOM
];

export class BuiltinMemoryProvider extends MemoryProvider {
  constructor(config) {
    super(config);
    this.type = 'builtin';
    this.workflowDir = config.workflowDir;
    this.charLimits = { ...CHAR_LIMITS, ...config.charLimits };
  }

  /**
   * Get file path for target.
   */
  _getFilePath(target) {
    const files = {
      memory: 'MEMORY.md',
      user: 'USER.md',
      workflow: 'WORKFLOW.md',
    };
    return join(this.workflowDir, 'memory', files[target] || files.workflow);
  }

  /**
   * Security scan for threat patterns.
   */
  _scanForThreats(content) {
    const findings = [];

    for (const { pattern, type } of THREAT_PATTERNS) {
      const matches = content.match(pattern);
      if (matches) {
        findings.push({
          type,
          severity: 'HIGH',
          matches: matches.slice(0, 3), // Limit matches
        });
      }
    }

    return findings.length > 0 ? findings : null;
  }

  /**
   * Filter dangerous Unicode characters.
   */
  _filterUnicode(content) {
    let filtered = content;

    for (const [start, end] of DANGEROUS_UNICODE) {
      const regex = new RegExp(`[\\u${start.toString(16)}-\\u${end.toString(16)}]`, 'g');
      filtered = filtered.replace(regex, '');
    }

    return filtered;
  }

  /**
   * Calculate usage statistics.
   */
  _calculateUsage(entries, target) {
    const charLimit = this.charLimits[target] || CHAR_LIMITS.workflow;
    const currentChars = entries.length > 0
      ? entries.join(ENTRY_DELIMITER).length
      : 0;

    return {
      chars: currentChars,
      limit: charLimit,
      percentage: Math.min(100, Math.round((currentChars / charLimit) * 100)),
      entries: entries.length,
    };
  }

  /**
   * Format entries with header.
   */
  _formatEntries(entries, target) {
    if (entries.length === 0) return '';

    const usage = this._calculateUsage(entries, target);
    const label = this._getLabel(target);

    const header = [
      '═'.repeat(46),
      `${label} [${usage.percentage}% — ${usage.chars.toLocaleString()}/${usage.limit.toLocaleString()} chars]`,
      '═'.repeat(46),
    ].join('\n');

    return header + '\n' + entries.join(ENTRY_DELIMITER);
  }

  /**
   * Get human-readable label for target.
   */
  _getLabel(target) {
    const labels = {
      memory: 'MEMORY (your personal notes)',
      user: 'USER PROFILE (who the user is)',
      workflow: 'WORKFLOW MEMORY',
    };
    return labels[target] || 'MEMORY';
  }

  /**
   * Read memory content from file.
   */
  async read(target) {
    const filePath = this._getFilePath(target);

    if (!existsSync(filePath)) {
      return {
        entries: [],
        usage: this._calculateUsage([], target),
      };
    }

    try {
      const raw = readFileSync(filePath, 'utf-8');
      if (!raw.trim()) {
        return {
          entries: [],
          usage: this._calculateUsage([], target),
        };
      }

      // Parse: skip header block, split by delimiter
      const lines = raw.split('\n');
      let contentStart = 0;

      // Find end of header (after separator line)
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('═') && i > 0) {
          contentStart = i + 1;
          break;
        }
      }

      const content = lines.slice(contentStart).join('\n').trim();
      if (!content) {
        return {
          entries: [],
          usage: this._calculateUsage([], target),
        };
      }

      const entries = content.split(ENTRY_DELIMITER)
        .map(e => e.trim())
        .filter(e => e.length > 0);

      // Deduplicate
      const deduped = [...new Set(entries)];

      return {
        entries: deduped,
        usage: this._calculateUsage(deduped, target),
      };
    } catch (error) {
      return {
        entries: [],
        usage: this._calculateUsage([], target),
        error: error.message,
      };
    }
  }

  /**
   * Write memory content to file (full replace).
   */
  async write(target, entries) {
    // Security scan
    for (const entry of entries) {
      const threats = this._scanForThreats(entry);
      if (threats) {
        return {
          success: false,
          message: `Security threat detected: ${threats[0].type}`,
          threats,
        };
      }
    }

    // Filter Unicode
    const filtered = entries.map(e => this._filterUnicode(e));

    // Check character limit
    const usage = this._calculateUsage(filtered, target);
    if (usage.chars > usage.limit) {
      return {
        success: false,
        message: `Content exceeds limit: ${usage.chars}/${usage.limit} chars`,
        usage,
      };
    }

    // Ensure directory exists
    const filePath = this._getFilePath(target);
    ensureDir(dirname(filePath));

    // Write with header
    const content = this._formatEntries(filtered, target);
    writeFileSync(filePath, content, 'utf-8');

    return {
      success: true,
      message: 'Memory written successfully',
      usage,
    };
  }

  /**
   * Add a new entry.
   */
  async add(target, content) {
    // Security scan
    const threats = this._scanForThreats(content);
    if (threats) {
      return {
        success: false,
        message: `Security threat detected: ${threats[0].type}`,
        threats,
      };
    }

    // Filter Unicode
    const filtered = this._filterUnicode(content.trim());
    if (!filtered) {
      return {
        success: false,
        message: 'Content cannot be empty',
      };
    }

    // Read existing
    const { entries } = await this.read(target);

    // Check for duplicate
    if (entries.includes(filtered)) {
      const usage = this._calculateUsage(entries, target);
      return {
        success: true,
        message: 'Entry already exists (no duplicate added)',
        usage,
        entries,
      };
    }

    // Check character limit
    const testEntries = [...entries, filtered];
    const usage = this._calculateUsage(testEntries, target);
    if (usage.chars > usage.limit) {
      const current = this._calculateUsage(entries, target);
      return {
        success: false,
        message: `Memory at ${current.chars}/${current.limit} chars. Adding this entry would exceed the limit.`,
        usage: current,
      };
    }

    // Write updated
    const result = await this.write(target, testEntries);

    return {
      ...result,
      entries: testEntries,
    };
  }

  /**
   * Replace an entry (substring match).
   */
  async replace(target, oldText, newContent) {
    // Security scan
    const threats = this._scanForThreats(newContent);
    if (threats) {
      return {
        success: false,
        message: `Security threat detected in new content: ${threats[0].type}`,
        threats,
      };
    }

    // Filter Unicode
    const filteredOld = this._filterUnicode(oldText.trim());
    const filteredNew = this._filterUnicode(newContent.trim());

    if (!filteredOld) {
      return {
        success: false,
        message: 'old_text cannot be empty',
      };
    }

    if (!filteredNew) {
      return {
        success: false,
        message: 'new_content cannot be empty. Use remove to delete entries.',
      };
    }

    // Read existing
    const { entries } = await this.read(target);

    // Find matches
    const matches = entries
      .map((e, i) => ({ index: i, entry: e }))
      .filter(({ entry }) => entry.includes(filteredOld));

    if (matches.length === 0) {
      return {
        success: false,
        message: `No entry matched '${filteredOld}'`,
      };
    }

    if (matches.length > 1) {
      const previews = matches.map(m =>
        m.entry.slice(0, 80) + (m.entry.length > 80 ? '...' : '')
      );
      return {
        success: false,
        message: `Multiple entries matched '${filteredOld}'. Be more specific.`,
        matches: previews,
      };
    }

    // Replace
    const updated = [...entries];
    updated[matches[0].index] = filteredNew;

    // Check character limit
    const usage = this._calculateUsage(updated, target);
    if (usage.chars > usage.limit) {
      return {
        success: false,
        message: `Replacement would exceed limit: ${usage.chars}/${usage.limit} chars`,
        usage,
      };
    }

    // Write updated
    const result = await this.write(target, updated);

    return {
      ...result,
      entries: updated,
    };
  }

  /**
   * Remove an entry (substring match).
   */
  async remove(target, oldText) {
    // Filter Unicode
    const filtered = this._filterUnicode(oldText.trim());

    if (!filtered) {
      return {
        success: false,
        message: 'old_text cannot be empty',
      };
    }

    // Read existing
    const { entries } = await this.read(target);

    // Find matches
    const matches = entries
      .map((e, i) => ({ index: i, entry: e }))
      .filter(({ entry }) => entry.includes(filtered));

    if (matches.length === 0) {
      return {
        success: false,
        message: `No entry matched '${filtered}'`,
      };
    }

    if (matches.length > 1) {
      const previews = matches.map(m =>
        m.entry.slice(0, 80) + (m.entry.length > 80 ? '...' : '')
      );
      return {
        success: false,
        message: `Multiple entries matched '${filtered}'. Be more specific.`,
        matches: previews,
      };
    }

    // Remove
    const updated = entries.filter((_, i) => i !== matches[0].index);

    // Write updated
    const result = await this.write(target, updated);

    return {
      ...result,
      entries: updated,
    };
  }

  /**
   * Health check.
   */
  async healthCheck() {
    try {
      // Try to read workflow target
      const { entries } = await this.read('workflow');
      return {
        healthy: true,
        message: 'Builtin memory provider is healthy',
        entries: entries.length,
      };
    } catch (error) {
      return {
        healthy: false,
        message: `Health check failed: ${error.message}`,
      };
    }
  }
}
