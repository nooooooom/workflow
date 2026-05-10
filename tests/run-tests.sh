#!/usr/bin/env bash
# Test runner for Workflow skill tests
# 工作流技能测试运行器
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# ── macOS/Linux timeout 兼容层 ────────────────────────────
if ! command -v timeout &> /dev/null; then
  if command -v gtimeout &> /dev/null; then
    timeout() { gtimeout "$@"; }
  else
    echo "WARNING: timeout/gtimeout not found. Tests will run without timeout." >&2
    echo "  Install on macOS: brew install coreutils" >&2
    timeout() { shift; "$@"; }
  fi
fi

echo "========================================"
echo " Workflow Skill Test Suite"
echo "========================================"
echo ""
echo "Repository: $(cd ../.. && pwd)"
echo "Test time: $(date)"
echo "Claude version: $(claude --version 2>/dev/null || echo 'not found')"
echo ""

# Check if Claude Code is available
if ! command -v claude &> /dev/null; then
    echo "ERROR: Claude Code CLI not found"
    echo "Install Claude Code first: https://code.claude.com"
    exit 1
fi

# Parse command line arguments
VERBOSE=false
SPECIFIC_TEST=""
TIMEOUT=300  # Default 5 minute timeout per test

while [[ $# -gt 0 ]]; do
    case $1 in
        --verbose|-v)
            VERBOSE=true
            shift
            ;;
        --test|-t)
            SPECIFIC_TEST="$2"
            shift 2
            ;;
        --timeout)
            TIMEOUT="$2"
            shift 2
            ;;
        --help|-h)
            echo "Usage: $0 [options]"
            echo ""
            echo "Options:"
            echo "  --verbose, -v        Show verbose output"
            echo "  --test, -t NAME      Run only the specified test"
            echo "  --timeout SECONDS    Set timeout per test (default: 300)"
            echo "  --help, -h           Show this help"
            echo ""
            echo "Shell Tests (require Claude Code CLI):"
            echo "  test-workflow-skill.sh  Test workflow skill loading and requirements"
            echo "  test-protocols.sh       Test protocol compliance"
            echo "  test-custom-gates.sh    Test custom gate configurations"
            echo ""
            echo "Integration Tests (require Claude Code CLI, slower):"
            echo "  integration-test.sh     Full workflow execution test"
            echo ""
            echo "Node Tests (run with node --test):"
            echo "  dual-memory.test.mjs    Dual-layer memory system tests"
            echo "  plugin-memory.test.mjs  Plugin memory provider tests"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            echo "Use --help for usage information"
            exit 1
            ;;
    esac
done

# Track results — must be initialized before any test runs
passed=0
failed=0
skipped=0

# List of shell tests to run (require Claude Code CLI)
tests=(
    "test-workflow-skill.sh"
    "test-protocols.sh"
    "test-custom-gates.sh"
)

# Run Node.js tests first (fast, no Claude CLI needed)
echo "----------------------------------------"
echo "Running: Node.js unit tests"
echo "----------------------------------------"

node_test_start=$(date +%s)
if node --test "$SCRIPT_DIR/dual-memory.test.mjs" "$SCRIPT_DIR/plugin-memory.test.mjs" 2>&1; then
    node_test_end=$(date +%s)
    node_test_duration=$((node_test_end - node_test_start))
    echo "  [PASS] Node.js tests (${node_test_duration}s)"
    passed=$((passed + 1))
else
    node_test_end=$(date +%s)
    node_test_duration=$((node_test_end - node_test_start))
    echo "  [FAIL] Node.js tests (${node_test_duration}s)"
    failed=$((failed + 1))
fi
echo ""

# Filter to specific test if requested
if [ -n "$SPECIFIC_TEST" ]; then
    tests=("$SPECIFIC_TEST")
fi

# Run each test
for test in "${tests[@]}"; do
    echo "----------------------------------------"
    echo "Running: $test"
    echo "----------------------------------------"

    test_path="$SCRIPT_DIR/$test"

    if [ ! -f "$test_path" ]; then
        echo "  [SKIP] Test file not found: $test"
        skipped=$((skipped + 1))
        continue
    fi

    if [ ! -x "$test_path" ]; then
        echo "  Making $test executable..."
        chmod +x "$test_path"
    fi

    start_time=$(date +%s)

    if [ "$VERBOSE" = true ]; then
        if timeout "$TIMEOUT" bash "$test_path"; then
            end_time=$(date +%s)
            duration=$((end_time - start_time))
            echo ""
            echo "  [PASS] $test (${duration}s)"
            passed=$((passed + 1))
        else
            exit_code=$?
            end_time=$(date +%s)
            duration=$((end_time - start_time))
            echo ""
            if [ $exit_code -eq 124 ]; then
                echo "  [FAIL] $test (timeout after ${TIMEOUT}s)"
            else
                echo "  [FAIL] $test (${duration}s)"
            fi
            failed=$((failed + 1))
        fi
    else
        # Capture output for non-verbose mode
        if output=$(timeout "$TIMEOUT" bash "$test_path" 2>&1); then
            end_time=$(date +%s)
            duration=$((end_time - start_time))
            echo "  [PASS] (${duration}s)"
            passed=$((passed + 1))
        else
            exit_code=$?
            end_time=$(date +%s)
            duration=$((end_time - start_time))
            if [ $exit_code -eq 124 ]; then
                echo "  [FAIL] (timeout after ${TIMEOUT}s)"
            else
                echo "  [FAIL] (${duration}s)"
            fi
            echo ""
            echo "  Output:"
            echo "$output" | sed 's/^/    /'
            failed=$((failed + 1))
        fi
    fi

    echo ""
done

# Print summary
echo "========================================"
echo " Test Results Summary"
echo "========================================"
echo ""
echo "  Passed:  $passed"
echo "  Failed:  $failed"
echo "  Skipped: $skipped"
echo ""

if [ $failed -gt 0 ]; then
    echo "STATUS: FAILED"
    exit 1
else
    echo "STATUS: PASSED"
    exit 0
fi