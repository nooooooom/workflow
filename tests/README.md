# Workflow Engine Tests

工作流引擎的自动化测试套件。

## 概述

本测试套件包含：

| 测试文件 | 类型 | 运行环境 | 说明 |
|---------|------|---------|------|
| `dual-memory.test.mjs` | 单元测试 | Node.js | 双层记忆系统测试 |
| `plugin-memory.test.mjs` | 单元测试 | Node.js | 插件化记忆提供者测试 |
| `test-workflow-skill.sh` | Skill 测试 | Claude Code CLI | 验证 skill 加载和核心概念 |
| `test-protocols.sh` | 协议测试 | Claude Code CLI | 验证各协议的遵循情况 |
| `test-custom-gates.sh` | 门控测试 | Claude Code CLI | 验证自定义门控配置 |
| `integration-test.sh` | 集成测试 | Claude Code CLI | 完整工作流执行测试 |
| `run-tests.sh` | 测试运行器 | — | 统一测试执行 |
| `test-helpers.sh` | 工具函数 | — | 通用测试辅助函数 |

## 快速开始

### 运行所有测试（推荐）

```bash
./run-tests.sh
```

### 仅运行 Node.js 单元测试（快速，无需 Claude CLI）

```bash
node --test tests/dual-memory.test.mjs tests/plugin-memory.test.mjs
```

### 运行单个 Shell 测试

```bash
./run-tests.sh --test test-workflow-skill.sh
```

### 详细输出模式

```bash
./run-tests.sh --verbose
```

### 运行集成测试（较慢，5-10 分钟）

```bash
./run-tests.sh --test integration-test.sh --timeout 600
```

## 测试结构

### test-helpers.sh

通用测试工具函数：

- `run_claude "prompt" [timeout]` - 运行 Claude 并获取输出
- `assert_contains output pattern name` - 验证是否包含模式
- `assert_not_contains output pattern name` - 验证是否不包含模式
- `assert_count output pattern count name` - 验证匹配计数
- `assert_order output pattern_a pattern_b name` - 验证顺序
- `create_test_project` - 创建临时测试目录
- `create_test_workflow project_dir name` - 创建工作流配置（workflow.json + state.json）
- `create_test_step workflow_dir name content` - 创建步骤文件
- `assert_run_status workflow_dir run_id status name` - 验证运行实例状态

### test-workflow-skill.sh

验证 workflow skill 的核心功能（约 3-5 分钟）：

1. **Skill 加载** - 验证 skill 被正确识别
2. **执行流程顺序** - START → EXECUTE → COMPLETE → GATE → [LOOP] → NEXT
3. **门控协议强制执行** - 验证门控不可跳过
4. **状态管理** - workflow.json + state.json 状态持久化
5. **核心规则** - 6 条不可违反的规则
6. **循环防护** - 防止无限循环
7. **Provider 类型** - null / skill / agent / command
8. **恢复机制** - advance.mjs status + resume.md
9. **上下文压缩** - 多级记忆系统
10. **自动演化** - 经验提取与注入
11. **路由强制** - 匹配到工作流后必须走工作流引擎

### integration-test.sh

完整工作流执行测试（约 5-10 分钟）：

1. **工作流结构验证** - workflow.json, runs/, state.json, steps/
2. **工作流定义验证** - name, steps, gate, dependsOn 字段
3. **运行状态验证** - status, current_step, step_states 字段
4. **Skill 加载配置** - 验证 skill 能读取配置
5. **步骤执行模拟** - 模拟步骤执行和产物创建
6. **门控失败处理** - 失败后修复重试
7. **恢复场景** - 中断后恢复
8. **演化系统** - 经验提取与注入

## 测试覆盖

| 功能模块 | 测试覆盖 |
|---------|---------|
| 步骤推进（advance.mjs） | 状态机、DAG 依赖、并行执行 |
| 门控验证（gate.mjs） | 类型、判定规则、失败处理 |
| 循环重试（loop.mjs） | 最大迭代、指数退避 |
| 中断恢复 | status 恢复、resume.md |
| Provider 执行 | null / skill / agent / command |
| 上下文管理 | 多级记忆、压缩、快照 |
| 自动演化（evolve.mjs） | 经验提取、注入、存档 |
| 记忆系统 | 双层记忆、插件化、安全扫描 |
| 生命周期钩子 | 自动触发 |

## CI/CD 集成

在 CI 环境中运行（仅 Node.js 测试，Shell 测试需要 Claude CLI）：

```bash
# Node.js 单元测试
node --test tests/dual-memory.test.mjs tests/plugin-memory.test.mjs

# 打包验证
bash scripts/package-skill.sh /tmp/workflow-ci.zip
```

## 注意事项

- Shell 测试需要 Claude Code CLI 环境
- Node.js 测试无需 Claude CLI，可在任何 Node.js >= 16 环境运行
- 完整工作流测试会非常慢（5-10 分钟）
- 测试应该是确定性的
- 避免测试实现细节
