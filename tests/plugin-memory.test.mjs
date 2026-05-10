#!/usr/bin/env node

/**
 * Test: Plugin-based Memory System
 *
 * Tests:
 * 1. MemoryProvider ABC (abstract class behavior)
 * 2. BuiltinMemoryProvider (file-based storage)
 * 3. MemoryManager (multi-provider management)
 * 4. Security features (threat detection, Unicode filtering)
 * 5. Export/Import functionality
 */

import { strict as assert } from 'assert';
import { existsSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { MemoryProvider } from '../engine/memory-provider.mjs';
import { BuiltinMemoryProvider } from '../engine/builtin-memory-provider.mjs';
import { MemoryManager } from '../engine/memory-manager.mjs';

const TEST_DIR = '.workflows/test-plugin-memory';

// Helper to create test workflow
function setupTestWorkflow() {
  mkdirSync(TEST_DIR, { recursive: true });
  mkdirSync(join(TEST_DIR, 'memory'), { recursive: true });

  // Create minimal workflow.json
  const workflowJson = {
    name: 'test-plugin-memory',
    description: 'Test workflow for plugin memory system',
    created_at: new Date().toISOString(),
    steps: [],
  };

  writeFileSync(join(TEST_DIR, 'workflow.json'), JSON.stringify(workflowJson, null, 2));
}

// Cleanup
function cleanup() {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

// ── Test 1: MemoryProvider ABC ───────────────────────────────

function testMemoryProviderABC() {
  console.log('Test 1: MemoryProvider ABC');

  // Should not be instantiable directly
  try {
    new MemoryProvider();
    assert.fail('Should throw error for abstract class');
  } catch (error) {
    assert(error.message.includes('abstract class'));
  }

  console.log('  ✓ Abstract class protection works');
  console.log('Test 1 passed\n');
}

// ── Test 2: BuiltinMemoryProvider Basic Operations ────────────

async function testBuiltinProviderBasic() {
  console.log('Test 2: BuiltinMemoryProvider Basic Operations');

  const provider = new BuiltinMemoryProvider({
    workflowDir: TEST_DIR,
  });

  // Test add
  const addResult = await provider.add('memory', 'Test entry 1');
  assert(addResult.success);
  console.log('  ✓ Add entry successful');

  // Test read
  const { entries, usage } = await provider.read('memory');
  assert(entries.length === 1);
  assert(entries[0] === 'Test entry 1');
  console.log('  ✓ Read entry successful');
  console.log('    Usage:', usage.percentage + '%');

  // Test add another
  await provider.add('memory', 'Test entry 2');
  const { entries: entries2 } = await provider.read('memory');
  assert(entries2.length === 2);
  console.log('  ✓ Add second entry successful');

  // Test replace
  const replaceResult = await provider.replace('memory', 'Test entry 1', 'Updated entry 1');
  assert(replaceResult.success);
  const { entries: entries3 } = await provider.read('memory');
  assert(entries3.includes('Updated entry 1'));
  console.log('  ✓ Replace entry successful');

  // Test remove
  const removeResult = await provider.remove('memory', 'Updated entry 1');
  assert(removeResult.success);
  const { entries: entries4 } = await provider.read('memory');
  assert(entries4.length === 1);
  assert(entries4[0] === 'Test entry 2');
  console.log('  ✓ Remove entry successful');

  console.log('Test 2 passed\n');
}

// ── Test 3: Character Limits ──────────────────────────────────

async function testCharacterLimits() {
  console.log('Test 3: Character Limits');

  const provider = new BuiltinMemoryProvider({
    workflowDir: TEST_DIR,
  });

  // Try to add content exceeding limit
  const longContent = 'A'.repeat(3000);
  const result = await provider.add('memory', longContent);

  assert(!result.success);
  assert(result.message.includes('exceed'));
  console.log('  ✓ Character limit enforced');
  console.log('    Message:', result.message.split('.')[0]);

  console.log('Test 3 passed\n');
}

// ── Test 4: Security Features ────────────────────────────────

async function testSecurityFeatures() {
  console.log('Test 4: Security Features');

  const provider = new BuiltinMemoryProvider({
    workflowDir: TEST_DIR,
  });

  // Test XSS detection
  const xssResult = await provider.add('memory', '<script>alert("XSS")</script>');
  assert(!xssResult.success);
  assert(xssResult.threats);
  assert(xssResult.threats[0].type === 'XSS');
  console.log('  ✓ XSS threat detected');

  // Test SQL injection detection
  const sqlResult = await provider.add('memory', 'UNION SELECT * FROM users');
  assert(!sqlResult.success);
  assert(sqlResult.threats[0].type === 'SQL_INJECTION');
  console.log('  ✓ SQL injection threat detected');

  // Test command injection detection
  const cmdResult = await provider.add('memory', '| rm -rf /');
  assert(!cmdResult.success);
  assert(cmdResult.threats[0].type === 'COMMAND_INJECTION');
  console.log('  ✓ Command injection threat detected');

  console.log('Test 4 passed\n');
}

// ── Test 5: Unicode Filtering ────────────────────────────────

async function testUnicodeFiltering() {
  console.log('Test 5: Unicode Filtering');

  const provider = new BuiltinMemoryProvider({
    workflowDir: TEST_DIR,
  });

  // Add content with dangerous Unicode
  const dangerousUnicode = 'Test\u200B\u200C\u200DContent'; // Zero-width spaces
  const result = await provider.add('memory', dangerousUnicode);

  assert(result.success);

  // Verify Unicode was filtered
  const { entries } = await provider.read('memory');
  assert(!entries[0].includes('\u200B'));
  console.log('  ✓ Dangerous Unicode filtered');

  console.log('Test 5 passed\n');
}

// ── Test 6: MemoryManager ─────────────────────────────────────

async function testMemoryManager() {
  console.log('Test 6: MemoryManager');

  const manager = new MemoryManager({
    workflowDir: TEST_DIR,
  });

  // Test default provider
  const providers = manager.listProviders();
  assert(providers.length === 1);
  assert(providers[0].name === 'builtin');
  console.log('  ✓ Default provider registered');

  // Test add through manager
  const addResult = await manager.add('user', 'Test preference');
  assert(addResult.success);
  console.log('  ✓ Add through manager successful');

  // Test read through manager
  const { entries } = await manager.read('user');
  assert(entries.length === 1);
  console.log('  ✓ Read through manager successful');

  // Test health check
  const health = await manager.healthCheck();
  assert(health.healthy);
  console.log('  ✓ Health check passed');

  console.log('Test 6 passed\n');
}

// ── Test 7: Export/Import ─────────────────────────────────────

async function testExportImport() {
  console.log('Test 7: Export/Import');

  // Create a fresh manager for this test
  const testDir = '.workflows/test-plugin-memory-export';
  mkdirSync(testDir, { recursive: true });
  mkdirSync(join(testDir, 'memory'), { recursive: true });

  const workflowJson = {
    name: 'test-export',
    steps: [],
  };
  writeFileSync(join(testDir, 'workflow.json'), JSON.stringify(workflowJson, null, 2));

  const manager = new MemoryManager({
    workflowDir: testDir,
  });

  // Add some entries
  await manager.add('memory', 'Test fact 1');
  await manager.add('user', 'Test preference 1');

  // Export
  const exported = await manager.exportMemory(['memory', 'user']);
  assert(exported.memory.entries.length === 1);
  assert(exported.user.entries.length === 1);
  console.log('  ✓ Export successful');

  // Clear
  await manager.write('memory', []);
  await manager.write('user', []);

  // Import
  const importResult = await manager.importMemory(exported);
  assert(importResult.memory.success);
  assert(importResult.user.success);
  console.log('  ✓ Import successful');

  // Verify
  const { entries: memEntries } = await manager.read('memory');
  const { entries: userEntries } = await manager.read('user');
  assert(memEntries.length === 1);
  assert(userEntries.length === 1);
  console.log('  ✓ Import verified');

  // Cleanup
  rmSync(testDir, { recursive: true, force: true });

  console.log('Test 7 passed\n');
}

// ── Test 8: Multiple Providers ────────────────────────────────

async function testMultipleProviders() {
  console.log('Test 8: Multiple Providers');

  const manager = new MemoryManager({
    workflowDir: TEST_DIR,
  });

  // Create a mock provider
  class MockProvider extends MemoryProvider {
    constructor() {
      super({ type: 'mock' });
      this.data = new Map();
    }

    async read(target) {
      return {
        entries: this.data.get(target) || [],
        usage: { chars: 0, limit: 1000, percentage: 0 },
      };
    }

    async write(target, entries) {
      this.data.set(target, entries);
      return { success: true, usage: { chars: 0, limit: 1000, percentage: 0 } };
    }

    async add(target, content) {
      const existing = this.data.get(target) || [];
      existing.push(content);
      this.data.set(target, existing);
      return { success: true, usage: { chars: 0, limit: 1000, percentage: 0 } };
    }

    async replace(target, oldText, newContent) {
      const entries = this.data.get(target) || [];
      const idx = entries.findIndex(e => e.includes(oldText));
      if (idx >= 0) {
        entries[idx] = newContent;
        return { success: true };
      }
      return { success: false, message: 'Not found' };
    }

    async remove(target, oldText) {
      const entries = this.data.get(target) || [];
      const filtered = entries.filter(e => !e.includes(oldText));
      this.data.set(target, filtered);
      return { success: true };
    }

    async healthCheck() {
      return { healthy: true, message: 'Mock provider healthy' };
    }
  }

  // Register mock provider
  manager.registerProvider('mock', new MockProvider());
  console.log('  ✓ Mock provider registered');

  // List providers
  const providers = manager.listProviders();
  assert(providers.length === 2);
  console.log('  ✓ Multiple providers registered');

  // Switch to mock provider
  const switchResult = manager.switchProvider('mock');
  assert(switchResult.success);
  console.log('  ✓ Switched to mock provider');

  // Test operations with mock
  await manager.add('test', 'Mock entry');
  const { entries } = await manager.read('test');
  assert(entries.length === 1);
  console.log('  ✓ Mock provider operations successful');

  console.log('Test 8 passed\n');
}

// ── Run All Tests ────────────────────────────────────────────

async function runAllTests() {
  console.log('====================================');
  console.log('Plugin Memory System Tests');
  console.log('====================================\n');

  try {
    setupTestWorkflow();

    testMemoryProviderABC();
    await testBuiltinProviderBasic();
    await testCharacterLimits();
    await testSecurityFeatures();
    await testUnicodeFiltering();
    await testMemoryManager();
    await testExportImport();
    await testMultipleProviders();

    console.log('====================================');
    console.log('All tests passed! ✓');
    console.log('====================================\n');

    cleanup();
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    console.error(error.stack);
    cleanup();
    process.exit(1);
  }
}

runAllTests();
