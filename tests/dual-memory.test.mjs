#!/usr/bin/env node

/**
 * Test: Dual-Layer Memory System
 *
 * Tests:
 * 1. Add memory to MEMORY.md
 * 2. Add user preferences to USER.md
 * 3. Verify character limits
 * 4. Verify percentage display
 * 5. Verify entries are separate files
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..');

const TEST_DIR = join(PROJECT_ROOT, '.workflows/test-dual-memory');

// Helper to run context-manager commands
function runMemoryCommand(action, content, target, oldText = null) {
  let cmd = `node engine/context-manager.mjs memory --dir "${TEST_DIR}" --action ${action}`;

  if (content) {
    cmd += ` --content '${content}'`;
  }

  if (target) {
    cmd += ` --target ${target}`;
  }

  if (oldText) {
    cmd += ` --old-text '${oldText}'`;
  }

  try {
    const result = execSync(cmd, { encoding: 'utf-8', cwd: PROJECT_ROOT });
    return JSON.parse(result);
  } catch (error) {
    console.error('Command failed:', cmd);
    console.error('Error:', error.message);
    throw error;
  }
}

// Setup test directory
function setup() {
  console.log('Setting up test directory...');

  // Create test workflow directory
  mkdirSync(TEST_DIR, { recursive: true });

  // Create minimal workflow.json
  const workflowJson = {
    name: 'test-dual-memory',
    description: 'Test workflow for dual-layer memory',
    created_at: new Date().toISOString(),
    steps: [],
    hooks: {
      on_step_start: [],
      on_step_complete: [],
      on_gate_pass: [],
      on_gate_fail: [],
      on_workflow_complete: [],
      on_loop_start: [],
      on_loop_exit: []
    }
  };

  writeFileSync(join(TEST_DIR, 'workflow.json'), JSON.stringify(workflowJson, null, 2));
  console.log('✓ Test directory created\n');
}

// Test 1: Add memory to MEMORY.md
function testAddMemory() {
  console.log('Test 1: Add memory to MEMORY.md');

  const result = runMemoryCommand(
    'add',
    'API 服务使用 JWT RS256 签名，密钥在 ~/.ssh/jwt_rs256.pem',
    'memory'
  );

  if (!result.ok) {
    throw new Error('Failed to add memory');
  }

  if (result.target !== 'memory') {
    throw new Error('Wrong target returned');
  }

  console.log('  Result:', result.message);
  console.log('  Usage:', result.usage);
  console.log('✓ Test 1 passed\n');
}

// Test 2: Add user preferences to USER.md
function testAddUser() {
  console.log('Test 2: Add user preferences to USER.md');

  const result = runMemoryCommand(
    'add',
    '项目代码风格：Go 1.22，使用 chi router，测试用 ginkgo',
    'user'
  );

  if (!result.ok) {
    throw new Error('Failed to add user preference');
  }

  if (result.target !== 'user') {
    throw new Error('Wrong target returned');
  }

  console.log('  Result:', result.message);
  console.log('  Usage:', result.usage);
  console.log('✓ Test 2 passed\n');
}

// Test 3: Verify separate files
function testSeparateFiles() {
  console.log('Test 3: Verify separate files exist');

  const memoryPath = join(TEST_DIR, 'memory', 'MEMORY.md');
  const userPath = join(TEST_DIR, 'memory', 'USER.md');

  if (!existsSync(memoryPath)) {
    throw new Error('MEMORY.md not created');
  }

  if (!existsSync(userPath)) {
    throw new Error('USER.md not created');
  }

  console.log('  ✓ MEMORY.md exists');
  console.log('  ✓ USER.md exists');

  // Check content
  const memoryContent = readFileSync(memoryPath, 'utf-8');
  const userContent = readFileSync(userPath, 'utf-8');

  if (!memoryContent.includes('JWT RS256')) {
    throw new Error('MEMORY.md content incorrect');
  }

  if (!userContent.includes('Go 1.22')) {
    throw new Error('USER.md content incorrect');
  }

  console.log('  ✓ MEMORY.md content correct');
  console.log('  ✓ USER.md content correct');
  console.log('✓ Test 3 passed\n');
}

// Test 4: Verify character limits
function testCharLimits() {
  console.log('Test 4: Verify character limits');

  // Try to add a very long entry to MEMORY.md (limit: 2200 chars)
  const longContent = 'A'.repeat(3000);

  const result = runMemoryCommand('add', longContent, 'memory');

  if (result.ok) {
    throw new Error('Should have rejected content exceeding limit');
  }

  if (!result.error || !result.error.includes('exceed the limit')) {
    throw new Error('Wrong error message: ' + result.error);
  }

  console.log('  ✓ Long content correctly rejected');
  console.log('  Error:', result.error.split('.')[0]);
  console.log('✓ Test 4 passed\n');
}

// Test 5: Verify percentage display
function testPercentageDisplay() {
  console.log('Test 5: Verify percentage display');

  // Add another entry to memory
  const result = runMemoryCommand(
    'add',
    '数据库迁移工具使用 sqlc，配置在 db/sqlc.yaml',
    'memory'
  );

  if (!result.ok) {
    throw new Error('Failed to add second memory');
  }

  // Check percentage is in the response
  if (!result.usage.includes('%')) {
    throw new Error('Percentage not in usage: ' + result.usage);
  }

  console.log('  Usage:', result.usage);
  console.log('  ✓ Percentage displayed');

  // Check file content has header with percentage
  const memoryPath = join(TEST_DIR, 'memory', 'MEMORY.md');
  const content = readFileSync(memoryPath, 'utf-8');

  if (!content.includes('[0%') && !content.includes('chars]')) {
    throw new Error('Header format incorrect');
  }

  console.log('  ✓ File header format correct');
  console.log('✓ Test 5 passed\n');
}

// Test 6: Test replace and remove
function testReplaceAndRemove() {
  console.log('Test 6: Test replace and remove operations');

  // Replace in MEMORY.md
  const replaceResult = runMemoryCommand(
    'replace',
    '数据库使用 PostgreSQL 15，连接池 pgx',
    'memory',
    '数据库迁移工具使用 sqlc'
  );

  if (!replaceResult.ok) {
    throw new Error('Replace failed: ' + replaceResult.error);
  }

  console.log('  ✓ Replace successful');

  // Remove from USER.md
  const removeResult = runMemoryCommand(
    'remove',
    null,
    'user',
    '项目代码风格：Go 1.22'
  );

  if (!removeResult.ok) {
    throw new Error('Remove failed: ' + removeResult.error);
  }

  console.log('  ✓ Remove successful');
  console.log('✓ Test 6 passed\n');
}

// Cleanup
function cleanup() {
  console.log('Cleaning up...');
  rmSync(TEST_DIR, { recursive: true, force: true });
  console.log('✓ Test directory removed\n');
}

// Run all tests
async function runTests() {
  console.log('====================================');
  console.log('Dual-Layer Memory System Tests');
  console.log('====================================\n');

  try {
    setup();
    testAddMemory();
    testAddUser();
    testSeparateFiles();
    testCharLimits();
    testPercentageDisplay();
    testReplaceAndRemove();

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

runTests();
