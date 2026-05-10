#!/usr/bin/env bash
# Test: Workflow skill
# Verifies that the workflow skill is loaded correctly and follows the defined protocols
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/test-helpers.sh"

echo "=== Test: Workflow Skill ==="
echo ""

# Test 1: Verify skill can be loaded and recognized
echo "Test 1: Skill loading..."

output=$(run_claude "What is the workflow skill? Describe its purpose and key features briefly." 60)

if assert_contains "$output" "workflow\|工作流" "Skill is recognized" ; then
    : # pass
else
    exit 1
fi

if assert_contains "$output" "step\|步骤" "Mentions steps" ; then
    : # pass
else
    exit 1
fi

if assert_contains "$output" "gate\|门控\|验证" "Mentions gate verification" ; then
    : # pass
else
    exit 1
fi

echo ""

# Test 2: Verify execution flow order
echo "Test 2: Execution flow order..."

output=$(run_claude "In the workflow skill, what is the correct step execution order? List the phases from START to NEXT." 60)

if assert_order "$output" "START\|开始" "EXECUTE\|执行" "START before EXECUTE" ; then
    : # pass
else
    exit 1
fi

if assert_order "$output" "EXECUTE\|执行" "COMPLETE\|完成" "EXECUTE before COMPLETE" ; then
    : # pass
else
    exit 1
fi

if assert_order "$output" "COMPLETE\|完成" "GATE\|门控" "COMPLETE before GATE" ; then
    : # pass
else
    exit 1
fi

if assert_order "$output" "GATE\|门控" "NEXT\|推进" "GATE before NEXT" ; then
    : # pass
else
    exit 1
fi

echo ""

# Test 3: Verify gate protocol is mandatory
echo "Test 3: Gate protocol enforcement..."

output=$(run_claude "Can I skip the gate verification in the workflow skill if I'm in a hurry? What happens if a gate fails?" 60)

if assert_contains "$output" "cannot\|不能\|must not\|禁止\|强制" "Gate is mandatory" ; then
    : # pass
else
    exit 1
fi

if assert_contains "$output" "fail\|FAIL\|失败\|修复\|retry\|重试" "Mentions gate failure handling" ; then
    : # pass
else
    exit 1
fi

echo ""

# Test 4: Verify state management
echo "Test 4: State management..."

output=$(run_claude "Where does the workflow skill store its state? What files are used for state persistence?" 60)

if assert_contains "$output" "workflow\.json\|state\.json\|工作流" "Mentions workflow.json or state.json" ; then
    : # pass
else
    exit 1
fi

if assert_contains "$output" "recover\|恢复\|resume\|继续\|中断" "Mentions recovery" ; then
    : # pass
else
    exit 1
fi

echo ""

# Test 5: Verify core rules
echo "Test 5: Core rules..."

output=$(run_claude "What are the 6 core rules of the workflow skill that cannot be violated?" 60)

if assert_contains "$output" "rule\|规则\|must\|必须\|cannot\|不能" "Mentions rules" ; then
    : # pass
else
    exit 1
fi

if assert_contains "$output" "gate\|门控" "Mentions gate in rules" ; then
    : # pass
else
    exit 1
fi

if assert_contains "$output" "script\|脚本\|advance\|session" "Mentions engine scripts" ; then
    : # pass
else
    exit 1
fi

echo ""

# Test 6: Verify loop guard
echo "Test 6: Loop guard..."

output=$(run_claude "What prevents infinite loops in the workflow skill? How does loop guard work?" 60)

if assert_contains "$output" "loop\|循环\|guard\|防护\|max_iterations\|最大迭代" "Mentions loop guard" ; then
    : # pass
else
    exit 1
fi

echo ""

# Test 7: Verify provider types
echo "Test 7: Provider types..."

output=$(run_claude "What types of providers does the workflow skill support? List them." 60)

if assert_contains "$output" "null\|skill\|agent\|command" "Mentions provider types" ; then
    : # pass
else
    exit 1
fi

echo ""

# Test 8: Verify recovery mechanism
echo "Test 8: Recovery mechanism..."

output=$(run_claude "How does the workflow skill recover context after an interruption? What command is used?" 60)

if assert_contains "$output" "advance.*status\|status\|resume\|恢复\|继续" "Mentions status/resume recovery" ; then
    : # pass
else
    exit 1
fi

echo ""

# Test 9: Verify context compression
echo "Test 9: Context compression..."

output=$(run_claude "How does the workflow skill handle context compression? What memory levels are available?" 60)

if assert_contains "$output" "compress\|压缩\|context\|上下文\|memory\|记忆\|level\|级别" "Mentions context compression" ; then
    : # pass
else
    exit 1
fi

echo ""

# Test 10: Verify auto-evolution
echo "Test 10: Auto-evolution system..."

output=$(run_claude "What is the auto-evolution system in the workflow skill? How does it work?" 60)

if assert_contains "$output" "evolve\|演化\|lesson\|经验\|extract\|提取\|inject\|注入" "Mentions evolution system" ; then
    : # pass
else
    exit 1
fi

echo ""

# Test 11: Verify routing is mandatory
echo "Test 11: Workflow routing enforcement..."

output=$(run_claude "What happens if a user's request matches an existing workflow? Can the orchestrator bypass the workflow?" 60)

if assert_contains "$output" "bypass\|绕过\|禁止\|must\|必须\|routing\|路由\|强制" "Routing enforcement mentioned" ; then
    : # pass
else
    exit 1
fi

echo ""

echo "=== All workflow skill tests passed ==="
