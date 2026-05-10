#!/usr/bin/env bash
# Helper functions for Workflow skill tests
# 工作流技能测试的通用工具函数

set -euo pipefail

# ── macOS/Linux timeout 兼容层 ────────────────────────────
if ! command -v timeout &> /dev/null; then
  if command -v gtimeout &> /dev/null; then
    # macOS with coreutils installed via Homebrew
    timeout() { gtimeout "$@"; }
  else
    # Fallback: ignore timeout, run command directly
    echo "WARNING: timeout/gtimeout not found. Tests will run without timeout." >&2
    echo "  Install on macOS: brew install coreutils" >&2
    timeout() { shift; "$@"; }
  fi
fi

# 运行 Claude Code 并捕获输出
# Usage: run_claude "prompt text" [timeout_seconds] [allowed_tools]
run_claude() {
    local prompt="$1"
    local timeout="${2:-60}"
    local allowed_tools="${3:-}"
    local output_file
    output_file=$(mktemp)

    # 构建命令
    local cmd="claude -p \"$prompt\""
    if [ -n "$allowed_tools" ]; then
        cmd="$cmd --allowed-tools=$allowed_tools"
    fi

    # 以无头模式运行 Claude，带超时
    if timeout "$timeout" bash -c "$cmd" > "$output_file" 2>&1; then
        cat "$output_file"
        rm -f "$output_file"
        return 0
    else
        local exit_code=$?
        cat "$output_file" >&2
        rm -f "$output_file"
        return $exit_code
    fi
}

# 检查输出是否包含模式
# Usage: assert_contains "output" "pattern" "test name"
assert_contains() {
    local output="$1"
    local pattern="$2"
    local test_name="${3:-test}"

    if echo "$output" | grep -qi "$pattern"; then
        echo "  [PASS] $test_name"
        return 0
    else
        echo "  [FAIL] $test_name"
        echo "  Expected to find: $pattern"
        echo "  In output:"
        echo "$output" | sed 's/^/    /'
        return 1
    fi
}

# 检查输出是否不包含模式
# Usage: assert_not_contains "output" "pattern" "test name"
assert_not_contains() {
    local output="$1"
    local pattern="$2"
    local test_name="${3:-test}"

    if echo "$output" | grep -qi "$pattern"; then
        echo "  [FAIL] $test_name"
        echo "  Did not expect to find: $pattern"
        echo "  In output:"
        echo "$output" | sed 's/^/    /'
        return 1
    else
        echo "  [PASS] $test_name"
        return 0
    fi
}

# 检查输出是否匹配计数
# Usage: assert_count "output" "pattern" expected_count "test name"
assert_count() {
    local output="$1"
    local pattern="$2"
    local expected="$3"
    local test_name="${4:-test}"

    local actual
    actual=$(echo "$output" | grep -ci "$pattern" || echo "0")

    if [ "$actual" -eq "$expected" ]; then
        echo "  [PASS] $test_name (found $actual instances)"
        return 0
    else
        echo "  [FAIL] $test_name"
        echo "  Expected $expected instances of: $pattern"
        echo "  Found $actual instances"
        echo "  In output:"
        echo "$output" | sed 's/^/    /'
        return 1
    fi
}

# 检查模式 A 是否出现在模式 B 之前
# Usage: assert_order "output" "pattern_a" "pattern_b" "test name"
assert_order() {
    local output="$1"
    local pattern_a="$2"
    local pattern_b="$3"
    local test_name="${4:-test}"

    # 获取模式出现的行号
    local line_a
    local line_b
    line_a=$(echo "$output" | grep -ni "$pattern_a" | head -1 | cut -d: -f1 || echo "")
    line_b=$(echo "$output" | grep -ni "$pattern_b" | head -1 | cut -d: -f1 || echo "")

    if [ -z "$line_a" ]; then
        echo "  [FAIL] $test_name: pattern A not found: $pattern_a"
        return 1
    fi

    if [ -z "$line_b" ]; then
        echo "  [FAIL] $test_name: pattern B not found: $pattern_b"
        return 1
    fi

    if [ "$line_a" -lt "$line_b" ]; then
        echo "  [PASS] $test_name (A at line $line_a, B at line $line_b)"
        return 0
    else
        echo "  [FAIL] $test_name"
        echo "  Expected '$pattern_a' before '$pattern_b'"
        echo "  But found A at line $line_a, B at line $line_b"
        return 1
    fi
}

# 创建临时测试项目目录
# Usage: test_project=$(create_test_project)
create_test_project() {
    local test_dir
    test_dir=$(mktemp -d)
    echo "$test_dir"
}

# 清理测试项目
# Usage: cleanup_test_project "$test_dir"
cleanup_test_project() {
    local test_dir="$1"
    if [ -d "$test_dir" ]; then
        rm -rf "$test_dir"
    fi
}

# 创建工作流配置文件用于测试
# Usage: create_test_workflow "$project_dir" "workflow_name"
create_test_workflow() {
    local project_dir="$1"
    local workflow_name="${2:-test-workflow}"
    local workflow_dir="$project_dir/.workflows/$workflow_name"
    local run_id="run-20260101-test"

    mkdir -p "$workflow_dir/steps"
    mkdir -p "$workflow_dir/runs/$run_id/artifacts"
    mkdir -p "$workflow_dir/runs/$run_id/gates"

    # 创建 workflow.json
    cat > "$workflow_dir/workflow.json" <<'EOF'
{
  "name": "test-workflow",
  "description": "Test workflow for unit testing",
  "created_at": "2026-01-01T00:00:00Z",
  "steps": [
    {
      "id": 1,
      "name": "research",
      "instruction": "steps/01-research.md",
      "artifact": "artifacts/01-research.md",
      "provider": null,
      "dependsOn": [],
      "gate": {
        "enabled": true,
        "type": "review",
        "high_threshold": 3
      },
      "loop": {
        "enabled": false,
        "max_iterations": 3
      }
    },
    {
      "id": 2,
      "name": "implement",
      "instruction": "steps/02-implement.md",
      "artifact": "artifacts/02-implement.md",
      "provider": null,
      "dependsOn": [1],
      "gate": {
        "enabled": true,
        "type": "review",
        "high_threshold": 3
      },
      "loop": {
        "enabled": false,
        "max_iterations": 3
      }
    },
    {
      "id": 3,
      "name": "verify",
      "instruction": "steps/03-verify.md",
      "artifact": "artifacts/03-verify.md",
      "provider": null,
      "dependsOn": [2],
      "gate": {
        "enabled": true,
        "type": "review",
        "high_threshold": 3
      },
      "loop": {
        "enabled": false,
        "max_iterations": 3
      }
    }
  ],
  "hooks": {},
  "evolution": {
    "enabled": true
  }
}
EOF

    # 创建 state.json
    cat > "$workflow_dir/runs/$run_id/state.json" <<'EOF'
{
  "id": "run-20260101-test",
  "summary": "Test run",
  "status": "ready",
  "current_step": 1,
  "completed_steps": [],
  "step_states": {
    "1": { "status": "pending" },
    "2": { "status": "pending" },
    "3": { "status": "pending" }
  },
  "started_at": "2026-01-01T00:00:00Z",
  "completed_at": null,
  "updated_at": "2026-01-01T00:00:00Z"
}
EOF

    # 创建 history.json
    cat > "$workflow_dir/runs/$run_id/history.json" <<'EOF'
[
  { "event": "run_created", "at": "2026-01-01T00:00:00Z", "summary": "Test run" }
]
EOF

    echo "$workflow_dir"
}

# 创建测试步骤文件
# Usage: create_test_step "$workflow_dir" "step_name" "content"
create_test_step() {
    local workflow_dir="$1"
    local step_name="$2"
    local content="${3:-# Step $step_name}"
    local step_file="$workflow_dir/steps/step-$step_name.md"

    cat > "$step_file" <<EOF
# Step: $step_name

$content
EOF

    echo "$step_file"
}

# 验证 state.json 状态
# Usage: assert_run_status "$workflow_dir" "run_id" "expected_status" "test name"
assert_run_status() {
    local workflow_dir="$1"
    local run_id="$2"
    local expected_status="$3"
    local test_name="${4:-run status}"
    local state_file="$workflow_dir/runs/$run_id/state.json"

    if [ ! -f "$state_file" ]; then
        echo "  [FAIL] $test_name: state.json not found at $state_file"
        return 1
    fi

    if grep -q "\"status\": \"$expected_status\"" "$state_file"; then
        echo "  [PASS] $test_name"
        return 0
    else
        echo "  [FAIL] $test_name"
        echo "  Expected status: $expected_status"
        echo "  State content:"
        cat "$state_file" | sed 's/^/    /'
        return 1
    fi
}

# 导出的函数
export -f run_claude
export -f assert_contains
export -f assert_not_contains
export -f assert_count
export -f assert_order
export -f create_test_project
export -f cleanup_test_project
export -f create_test_workflow
export -f create_test_step
export -f assert_run_status
