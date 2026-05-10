/**
 * MemoryManager - Multi-Provider Memory Management
 *
 * Manages multiple memory providers and provides a unified interface.
 * Supports dynamic provider registration and switching.
 *
 * Design inspired by hermes-agent's MemoryManager.
 */

import { BuiltinMemoryProvider } from './builtin-memory-provider.mjs';

export class MemoryManager {
  constructor(config = {}) {
    this.providers = new Map();
    this.defaultProvider = config.defaultProvider || 'builtin';
    this.workflowDir = config.workflowDir;
    this.activeProvider = null;

    // Register built-in provider
    this._registerBuiltinProvider(config);
  }

  /**
   * Register built-in provider.
   */
  _registerBuiltinProvider(config) {
    const provider = new BuiltinMemoryProvider({
      workflowDir: this.workflowDir,
      charLimits: config.charLimits || {},
    });

    this.providers.set('builtin', provider);

    // Set as active if it's the default
    if (this.defaultProvider === 'builtin') {
      this.activeProvider = provider;
    }
  }

  /**
   * Register a custom provider.
   */
  registerProvider(name, provider) {
    if (this.providers.has(name)) {
      throw new Error(`Provider '${name}' is already registered`);
    }

    this.providers.set(name, provider);
  }

  /**
   * Switch active provider.
   */
  switchProvider(name) {
    if (!this.providers.has(name)) {
      throw new Error(`Provider '${name}' not found. Available: ${Array.from(this.providers.keys()).join(', ')}`);
    }

    this.activeProvider = this.providers.get(name);
    this.defaultProvider = name;

    return {
      success: true,
      provider: name,
      capabilities: this.activeProvider.getCapabilities(),
    };
  }

  /**
   * Get active provider.
   */
  getActiveProvider() {
    if (!this.activeProvider) {
      throw new Error('No active provider set');
    }
    return this.activeProvider;
  }

  /**
   * Get provider by name.
   */
  getProvider(name) {
    if (!this.providers.has(name)) {
      throw new Error(`Provider '${name}' not found`);
    }
    return this.providers.get(name);
  }

  /**
   * List all registered providers.
   */
  listProviders() {
    const list = [];

    for (const [name, provider] of this.providers.entries()) {
      list.push({
        name,
        type: provider.type,
        capabilities: provider.getCapabilities(),
        isActive: provider === this.activeProvider,
      });
    }

    return list;
  }

  // ── Delegate to active provider ─────────────────────────

  async read(target) {
    return this.getActiveProvider().read(target);
  }

  async write(target, entries) {
    return this.getActiveProvider().write(target, entries);
  }

  async add(target, content) {
    return this.getActiveProvider().add(target, content);
  }

  async replace(target, oldText, newContent) {
    return this.getActiveProvider().replace(target, oldText, newContent);
  }

  async remove(target, oldText) {
    return this.getActiveProvider().remove(target, oldText);
  }

  async healthCheck() {
    return this.getActiveProvider().healthCheck();
  }

  /**
   * Health check all providers.
   */
  async healthCheckAll() {
    const results = {};

    for (const [name, provider] of this.providers.entries()) {
      try {
        results[name] = await provider.healthCheck();
      } catch (error) {
        results[name] = {
          healthy: false,
          message: error.message,
        };
      }
    }

    return results;
  }

  /**
   * Export memory to JSON (for backup/migration).
   */
  async exportMemory(targets = ['memory', 'user', 'workflow']) {
    const exported = {};

    for (const target of targets) {
      const { entries, usage } = await this.read(target);
      exported[target] = {
        entries,
        usage,
        exportedAt: new Date().toISOString(),
      };
    }

    return exported;
  }

  /**
   * Import memory from JSON (for restore/migration).
   */
  async importMemory(data, options = { merge: false }) {
    const results = {};

    for (const [target, { entries }] of Object.entries(data)) {
      if (options.merge) {
        // Merge with existing
        const { entries: existing } = await this.read(target);
        const merged = [...new Set([...existing, ...entries])];

        const result = await this.write(target, merged);
        results[target] = result;
      } else {
        // Replace
        const result = await this.write(target, entries);
        results[target] = result;
      }
    }

    return results;
  }
}
