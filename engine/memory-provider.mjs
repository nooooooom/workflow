/**
 * MemoryProvider - Abstract Base Class
 *
 * Defines the standard interface for memory providers.
 * Inspired by hermes-agent's plugin architecture.
 *
 * All memory providers must implement these methods.
 */

export class MemoryProvider {
  constructor(config = {}) {
    if (new.target === MemoryProvider) {
      throw new Error('MemoryProvider is an abstract class and cannot be instantiated directly');
    }
    this.config = config;
    this.type = config.type || 'unknown';
  }

  /**
   * Read memory content.
   * @param {string} target - Memory target (e.g., 'memory', 'user', 'workflow')
   * @returns {Promise<{entries: string[], usage: object}>}
   */
  async read(target) {
    throw new Error('read() must be implemented by subclass');
  }

  /**
   * Write memory content (full replace).
   * @param {string} target - Memory target
   * @param {string[]} entries - Array of memory entries
   * @returns {Promise<{success: boolean, usage: object}>}
   */
  async write(target, entries) {
    throw new Error('write() must be implemented by subclass');
  }

  /**
   * Add a new entry.
   * @param {string} target - Memory target
   * @param {string} content - Entry content
   * @returns {Promise<{success: boolean, message: string, usage: object}>}
   */
  async add(target, content) {
    throw new Error('add() must be implemented by subclass');
  }

  /**
   * Replace an entry (substring match).
   * @param {string} target - Memory target
   * @param {string} oldText - Text to search for
   * @param {string} newContent - Replacement content
   * @returns {Promise<{success: boolean, message: string}>}
   */
  async replace(target, oldText, newContent) {
    throw new Error('replace() must be implemented by subclass');
  }

  /**
   * Remove an entry (substring match).
   * @param {string} target - Memory target
   * @param {string} oldText - Text to search for
   * @returns {Promise<{success: boolean, message: string}>}
   */
  async remove(target, oldText) {
    throw new Error('remove() must be implemented by subclass');
  }

  /**
   * Get provider capabilities.
   * @returns {object} - Capability flags
   */
  getCapabilities() {
    return {
      supportsRead: true,
      supportsWrite: true,
      supportsAdd: true,
      supportsReplace: true,
      supportsRemove: true,
      supportsSearch: false, // Override in subclass if supported
    };
  }

  /**
   * Health check.
   * @returns {Promise<{healthy: boolean, message: string}>}
   */
  async healthCheck() {
    throw new Error('healthCheck() must be implemented by subclass');
  }
}
