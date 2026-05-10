#!/bin/bash
# =============================================================================
# Test: Custom Gates (script, llm, composite) + Auto-Loop
# =============================================================================
# This script tests the new gate types and auto-loop functionality.
# =============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

PASS_COUNT=0
FAIL_COUNT=0

# Helper functions
pass() {
    echo -e "${GREEN}✓ PASS${NC}: $1"
    ((PASS_COUNT++))
}

fail() {
    echo -e "${RED}✗ FAIL${NC}: $1"
    ((FAIL_COUNT++))
}

section() {
    echo ""
    echo -e "${YELLOW}════════════════════════════════════════════════════════════${NC}"
    echo -e "${YELLOW}  $1${NC}"
    echo -e "${YELLOW}════════════════════════════════════════════════════════════${NC}"
}

# =============================================================================
# Test: Gate Commands Available
# =============================================================================
section "Test: Gate Commands Available"

# Test run command exists
OUTPUT=$(node "$PROJECT_ROOT/engine/gate.mjs" run 2>&1 || true)
if echo "$OUTPUT" | grep -q "dir.*required"; then
    pass "run command exists and validates --dir"
else
    fail "run command missing or broken"
fi

# Test result command exists
OUTPUT=$(node "$PROJECT_ROOT/engine/gate.mjs" result 2>&1 || true)
if echo "$OUTPUT" | grep -q "dir.*required"; then
    pass "result command exists and validates --dir"
else
    fail "result command missing or broken"
fi

# Test auto_retry command exists
OUTPUT=$(node "$PROJECT_ROOT/engine/gate.mjs" auto_retry 2>&1 || true)
if echo "$OUTPUT" | grep -q "dir.*required"; then
    pass "auto_retry command exists and validates --dir"
else
    fail "auto_retry command missing or broken"
fi

# Test extract command exists
OUTPUT=$(node "$PROJECT_ROOT/engine/gate.mjs" extract 2>&1 || true)
if echo "$OUTPUT" | grep -q "dir.*required"; then
    pass "extract command exists and validates --dir"
else
    fail "extract command missing or broken"
fi

# =============================================================================
# Test: Documentation Exists
# =============================================================================
section "Test: Documentation Exists"

if [ -f "$PROJECT_ROOT/docs/custom-gates.md" ]; then
    pass "docs/custom-gates.md exists"
    
    # Check for key sections
    if grep -q "Script Gates" "$PROJECT_ROOT/docs/custom-gates.md"; then
        pass "Documentation includes Script Gates section"
    else
        fail "Documentation missing Script Gates section"
    fi
    
    if grep -q "LLM Gates" "$PROJECT_ROOT/docs/custom-gates.md"; then
        pass "Documentation includes LLM Gates section"
    else
        fail "Documentation missing LLM Gates section"
    fi
    
    if grep -q "Composite Gates" "$PROJECT_ROOT/docs/custom-gates.md"; then
        pass "Documentation includes Composite Gates section"
    else
        fail "Documentation missing Composite Gates section"
    fi
    
    if grep -q "Auto-Loop" "$PROJECT_ROOT/docs/custom-gates.md"; then
        pass "Documentation includes Auto-Loop section"
    else
        fail "Documentation missing Auto-Loop section"
    fi
else
    fail "docs/custom-gates.md missing"
fi

# =============================================================================
# Summary
# =============================================================================
section "Test Summary"

echo ""
echo -e "Passed: ${GREEN}$PASS_COUNT${NC}"
echo -e "Failed: ${RED}$FAIL_COUNT${NC}"
echo ""

if [ $FAIL_COUNT -eq 0 ]; then
    echo -e "${GREEN}All tests passed!${NC}"
    exit 0
else
    echo -e "${RED}Some tests failed.${NC}"
    exit 1
fi
