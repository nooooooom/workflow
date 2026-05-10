#!/usr/bin/env bash
# Test: Protocol Compliance
# 测试各协议的遵循情况
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/test-helpers.sh"

echo "=== Test: Protocol Compliance ==="
echo ""

# Test 1: Gate Protocol - Gate Types
echo "Test 1: Gate Protocol - Gate Types..."

output=$(run_claude "What are the gate types supported by the workflow engine? List them with their executors." 60)

if assert_contains "$output" "review\|command\|tool\|manual" "Gate types mentioned" ; then
    : # pass
else
    exit 1
fi

echo ""

# Test 2: Gate Protocol - Decision Rules
echo "Test 2: Gate Protocol - Decision Rules..."

output=$(run_claude "What happens when a gate fails in the workflow engine? How is the decision made?" 60)

if assert_contains "$output" "fail\|FAIL\|失败\|修复" "Failure handling mentioned" ; then
    : # pass
else
    exit 1
fi

if assert_contains "$output" "retry\|重试\|loop\|循环\|fix\|修复" "Retry/fix mentioned" ; then
    : # pass
else
    exit 1
fi

echo ""

# Test 3: Gate Protocol - gate.mjs Commands
echo "Test 3: Gate Protocol - Engine Commands..."

output=$(run_claude "What are the gate.mjs commands? How do you run a gate and record a result?" 60)

if assert_contains "$output" "gate\.mjs\|gate.*run\|gate.*result" "gate.mjs commands mentioned" ; then
    : # pass
else
    exit 1
fi

echo ""

# Test 4: Advance Protocol - State Machine
echo "Test 4: Advance Protocol - State Machine..."

output=$(run_claude "What step states exist in the workflow engine? What are the valid state transitions?" 60)

if assert_contains "$output" "pending\|in_progress\|completed\|gate_pending" "Step states mentioned" ; then
    : # pass
else
    exit 1
fi

echo ""

# Test 5: Advance Protocol - DAG Dependencies
echo "Test 5: Advance Protocol - DAG Dependencies..."

output=$(run_claude "How does the workflow engine handle step dependencies? What is the DAG execution model?" 60)

if assert_contains "$output" "DAG\|depend\|依赖\|parallel\|并行" "DAG dependencies mentioned" ; then
    : # pass
else
    exit 1
fi

if assert_contains "$output" "ready\|advance.*ready\|可执行" "Ready steps mentioned" ; then
    : # pass
else
    exit 1
fi

echo ""

# Test 6: Recovery Protocol
echo "Test 6: Recovery Protocol..."

output=$(run_claude "How does the workflow engine handle recovery after interruption? What steps are taken?" 60)

if assert_contains "$output" "advance.*status\|status\|resume\|恢复" "Recovery via status command mentioned" ; then
    : # pass
else
    exit 1
fi

if assert_contains "$output" "current_step\|当前步骤\|resume\.md" "Current step identification" ; then
    : # pass
else
    exit 1
fi

echo ""

# Test 7: Loop Guard Protocol
echo "Test 7: Loop Guard Protocol..."

output=$(run_claude "How does the loop guard work in the workflow engine? What prevents infinite retries?" 60)

if assert_contains "$output" "loop\|循环\|max_iterations\|最大迭代" "Loop guard mentioned" ; then
    : # pass
else
    exit 1
fi

if assert_contains "$output" "backoff\|退避\|delay\|延迟" "Backoff mentioned" ; then
    : # pass
else
    exit 1
fi

echo ""

# Test 8: Context Compression Protocol
echo "Test 8: Context Compression Protocol..."

output=$(run_claude "How does the multi-level memory system work in the workflow engine? What are the 3 levels?" 60)

if assert_contains "$output" "level.*1\|level.*2\|level.*3\|级别" "Memory levels mentioned" ; then
    : # pass
else
    exit 1
fi

if assert_contains "$output" "compact\|压缩\|context-manager" "Compression mentioned" ; then
    : # pass
else
    exit 1
fi

echo ""

# Test 9: Provider Protocol
echo "Test 9: Provider Protocol..."

output=$(run_claude "What provider types does the workflow engine support? How do they execute steps?" 60)

if assert_contains "$output" "null\|skill\|agent\|command" "Provider types mentioned" ; then
    : # pass
else
    exit 1
fi

echo ""

# Test 10: Evolution Protocol
echo "Test 10: Evolution Protocol..."

output=$(run_claude "How does the auto-evolution system work? When are lessons extracted and injected?" 60)

if assert_contains "$output" "evolve\|演化\|extract\|提取\|inject\|注入" "Evolution mentioned" ; then
    : # pass
else
    exit 1
fi

if assert_contains "$output" "lesson\|经验\|step.*complete\|步骤完成" "Lesson extraction triggers" ; then
    : # pass
else
    exit 1
fi

echo ""

# Test 11: Hook Protocol
echo "Test 11: Hook Protocol..."

output=$(run_claude "What lifecycle hooks are available in the workflow engine? Are they triggered manually or automatically?" 60)

if assert_contains "$output" "hook\|钩子\|on_step_start\|on_step_complete\|on_gate_pass" "Hooks mentioned" ; then
    : # pass
else
    exit 1
fi

if assert_contains "$output" "automatic\|自动\|auto" "Automatic triggering mentioned" ; then
    : # pass
else
    exit 1
fi

echo ""

# Test 12: Evaluator Independence
echo "Test 12: Evaluator Independence Design..."

output=$(run_claude "What is the evaluator independence design in the workflow engine? Why separate generator from evaluator?" 60)

if assert_contains "$output" "evaluator\|评估\|independent\|独立\|separate\|分离" "Evaluator independence mentioned" ; then
    : # pass
else
    exit 1
fi

if assert_contains "$output" "bias\|偏见\|self.*assess\|自我评估\|harness" "Rationale for separation" ; then
    : # pass
else
    exit 1
fi

echo ""

echo "=== All protocol compliance tests passed ==="
