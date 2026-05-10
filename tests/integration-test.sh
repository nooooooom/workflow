#!/usr/bin/env bash
# Integration Test: Full Workflow Execution
# 集成测试：完整工作流执行
#
# This test creates a real workflow, executes it step by step,
# and verifies the final output and state transitions.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/test-helpers.sh"

echo "=== Integration Test: Full Workflow Execution ==="
echo ""

# Setup: Create test project and workflow
echo "Setting up test environment..."
test_project=$(create_test_project)
workflow_dir=$(create_test_workflow "$test_project" "integration-test")

echo "  Test project: $test_project"
echo "  Workflow directory: $workflow_dir"

# Verify workflow structure
echo ""
echo "Test 1: Workflow structure validation..."

if [ -f "$workflow_dir/workflow.json" ]; then
    echo "  [PASS] workflow.json exists"
else
    echo "  [FAIL] workflow.json not found"
    cleanup_test_project "$test_project"
    exit 1
fi

if [ -d "$workflow_dir/runs" ]; then
    echo "  [PASS] runs directory exists"
else
    echo "  [FAIL] runs directory not found"
    cleanup_test_project "$test_project"
    exit 1
fi

if [ -f "$workflow_dir/runs/run-20260101-test/state.json" ]; then
    echo "  [PASS] state.json exists"
else
    echo "  [FAIL] state.json not found"
    cleanup_test_project "$test_project"
    exit 1
fi

if [ -d "$workflow_dir/steps" ]; then
    echo "  [PASS] steps directory exists"
else
    echo "  [FAIL] steps directory not found"
    cleanup_test_project "$test_project"
    exit 1
fi

# Test 2: Verify workflow.json structure
echo ""
echo "Test 2: Workflow definition validation..."

output=$(cat "$workflow_dir/workflow.json")

if echo "$output" | grep -q '"name"'; then
    echo "  [PASS] name field exists"
else
    echo "  [FAIL] name field missing"
    cleanup_test_project "$test_project"
    exit 1
fi

if echo "$output" | grep -q '"steps"'; then
    echo "  [PASS] steps field exists"
else
    echo "  [FAIL] steps field missing"
    cleanup_test_project "$test_project"
    exit 1
fi

if echo "$output" | grep -q '"gate"'; then
    echo "  [PASS] gate config exists in steps"
else
    echo "  [FAIL] gate config missing from steps"
    cleanup_test_project "$test_project"
    exit 1
fi

if echo "$output" | grep -q '"dependsOn"'; then
    echo "  [PASS] dependsOn field exists"
else
    echo "  [FAIL] dependsOn field missing"
    cleanup_test_project "$test_project"
    exit 1
fi

# Test 3: Verify state.json structure
echo ""
echo "Test 3: Run state validation..."

output=$(cat "$workflow_dir/runs/run-20260101-test/state.json")

if echo "$output" | grep -q '"status"'; then
    echo "  [PASS] status field exists"
else
    echo "  [FAIL] status field missing"
    cleanup_test_project "$test_project"
    exit 1
fi

if echo "$output" | grep -q '"current_step"'; then
    echo "  [PASS] current_step field exists"
else
    echo "  [FAIL] current_step field missing"
    cleanup_test_project "$test_project"
    exit 1
fi

if echo "$output" | grep -q '"step_states"'; then
    echo "  [PASS] step_states field exists"
else
    echo "  [FAIL] step_states field missing"
    cleanup_test_project "$test_project"
    exit 1
fi

# Test 4: Verify workflow skill can load this config
echo ""
echo "Test 4: Workflow skill config loading..."

cd "$test_project"
output=$(run_claude "I have a workflow in .workflows/integration-test with workflow.json. Can you read and explain this workflow configuration?" 60)

if assert_contains "$output" "integration-test\|test-workflow" "Workflow is recognized" ; then
    : # pass
else
    cleanup_test_project "$test_project"
    exit 1
fi

# Test 5: Verify step execution simulation
echo ""
echo "Test 5: Step execution simulation..."

# Create a simple artifact to simulate step output
run_id="run-20260101-test"
mkdir -p "$workflow_dir/runs/$run_id/artifacts"
echo "# Step 1 Output" > "$workflow_dir/runs/$run_id/artifacts/01-research.md"
echo "This is the output from step 1 execution." >> "$workflow_dir/runs/$run_id/artifacts/01-research.md"

output=$(run_claude "I just completed step 1 of my workflow and created an artifact. What should I do next according to the workflow engine? The execution flow is START → EXECUTE → COMPLETE → GATE → NEXT." 60)

if assert_contains "$output" "complete\|COMPLETE\|完成\|gate\|GATE\|门控" "Mentions complete and gate" ; then
    : # pass
else
    cleanup_test_project "$test_project"
    exit 1
fi

# Test 6: Verify gate failure handling
echo ""
echo "Test 6: Gate failure handling..."

output=$(run_claude "My workflow gate verification failed. What should I do according to the workflow engine?" 60)

if assert_contains "$output" "fix\|修复\|resolve\|解决\|retry\|重试\|loop" "Must fix before proceeding" ; then
    : # pass
else
    cleanup_test_project "$test_project"
    exit 1
fi

# Test 7: Verify recovery scenario
echo ""
echo "Test 7: Recovery scenario..."

# Simulate an interrupted run
cat > "$workflow_dir/runs/$run_id/state.json" <<'EOF'
{
  "id": "run-20260101-test",
  "summary": "Test run",
  "status": "in_progress",
  "current_step": 2,
  "completed_steps": [1],
  "step_states": {
    "1": { "status": "completed", "started_at": "2026-01-01T00:00:00Z", "completed_at": "2026-01-01T00:01:00Z" },
    "2": { "status": "in_progress", "started_at": "2026-01-01T00:01:00Z" },
    "3": { "status": "pending" }
  },
  "started_at": "2026-01-01T00:00:00Z",
  "completed_at": null,
  "updated_at": "2026-01-01T00:01:00Z"
}
EOF

output=$(run_claude "I was interrupted while working on this workflow. How can I check the current status and resume?" 60)

if assert_contains "$output" "resume\|恢复\|continue\|继续\|status\|advance" "Offers to resume" ; then
    : # pass
else
    cleanup_test_project "$test_project"
    exit 1
fi

if assert_contains "$output" "step.*2\|implement\|步骤" "Identifies step to resume" ; then
    : # pass
else
    cleanup_test_project "$test_project"
    exit 1
fi

# Test 8: Verify evolution system
echo ""
echo "Test 8: Evolution system..."

output=$(run_claude "After completing a workflow, how are lessons extracted and injected for future runs?" 60)

if assert_contains "$output" "evolve\|演化\|lesson\|经验\|extract\|提取\|inject\|注入" "Mentions evolution elements" ; then
    : # pass
else
    cleanup_test_project "$test_project"
    exit 1
fi

# Cleanup
echo ""
echo "Cleaning up test environment..."
cleanup_test_project "$test_project"

echo ""
echo "=== All integration tests passed ==="
