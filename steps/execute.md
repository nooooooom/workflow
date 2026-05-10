---
name: execute
description: 步骤执行协议：START → EXECUTE → COMPLETE → GATE → LOOP → NEXT
---

# 步骤执行协议

每个步骤严格遵循以下流程。你负责 EXECUTE 阶段的内容执行，engine 脚本负责其余一切。

**⚠️ 重要**：所有生命周期钩子已内置在 engine 脚本中，你**不需要**手动调用 `hooks.mjs emit`。

## 流程

### START — 开始步骤

**何时调用**：步骤状态为 `pending` 或 `gate_failed` 时

```bash
node engine/advance.mjs start --dir "{workflow_dir}" --step {step_id}
```

**返回信息**：
- `instruction`（指令文件路径）
- `artifact`（产物路径）
- `provider`
- `handoff`（上一步的 handoff 文档，如果存在）

**自动触发的 Hook**：`on_step_start`

**下一步**：进入 CONTEXT LOADING 阶段

---

### CONTEXT LOADING — 加载上下文（START 后自动执行）

`advance.mjs start` 返回的 `handoff` 字段包含上一步生成的 handoff 文档。

**如果 `handoff` 存在**（推荐优先使用）：

1. 阅读 `handoff.workflow_context.completed_steps_summary` — 了解所有已完成步骤的工作（不受 3 步窗口限制）
2. 阅读 `handoff.what_was_done` — 上一步做了什么
3. 阅读 `handoff.critical_context_for_next_step` — 上一步认为你需要知道的关键信息
4. 阅读 `handoff.key_decisions` — 已做出的关键决策
5. 阅读 `handoff.open_questions` — 待解决问题
6. 将这些信息作为执行当前步骤的背景知识

**如果 `handoff` 为 null**（首步或旧工作流）：

使用 `context-manager.mjs compact` 获取压缩上下文，正常执行。

**下一步**：进入 EXECUTE 阶段

---

### EXECUTE — 执行步骤内容

**⚠️ 如果不确定指令内容，立即读取指令文件**：

```bash
# 示例
Read "{workflow_dir}/steps/step-01-research.md"
```

**路由 Provider**：

| provider 值 | 执行方式 |
|-------------|---------|
| `null` | 你直接按指令文件执行 |
| `skill:{name}` | 用 Skill 工具调用对应 skill |
| `agent:{name}` | 用 Agent 工具启动 subagent，把指令作为 prompt |
| `command:{cmd}` | 用 Bash 执行命令 |

**写产物**：

`advance.mjs start` 返回 `artifact_type`，决定写哪种产物：

**artifact_type: "content"**（默认）— 步骤产出是文档本身（分析、计划、设计）：

```bash
Write "{workflow_dir}/{artifact}" "{完整内容}"
```

**artifact_type: "reference"** — 步骤产出是项目中的实际文件（代码、配置、测试）：

先完成实际文件的创建/修改，然后写一个清单到产物路径。**不要**把文件内容复制到清单中：

```markdown
# Step: {step_name}

## Summary
一句话总结本步骤完成了什么。

## Files

| Action | Path | Description |
|--------|------|-------------|
| created | src/auth/middleware.ts | JWT 验证中间件 |
| modified | src/app.ts | 添加 auth 中间件到路由链 |
| deleted | src/auth/legacy.ts | 移除旧的认证逻辑 |

## Notes
可选：额外上下文、决策理由等。
```

规则：
- `Action` 只有三种：`created`、`modified`、`deleted`
- `Path` 使用项目根目录的相对路径
- `Description` 一句话，不超过 80 字符
- **不要在清单中复制文件内容** — 引用路径即可

**下一步**：进入 COMPLETE 阶段

---

### COMPLETE — 标记完成

**⚠️ 确保产物已写入**：在调用此命令前，必须已经用 Write 工具写入产物文件。

```bash
node engine/advance.mjs complete --dir "{workflow_dir}" --step {step_id}
```

**两种结果**：

1. **gate 未启用** → 直接 completed，跳到 NEXT
2. **gate 已启用** → 返回 `gate_pending`，进入 GATE 阶段

**自动触发的 Hook**：`on_step_complete`

---

### GATE — 门控验证

#### 步骤 1：获取 gate 配置

```bash
node engine/gate.mjs run --dir "{workflow_dir}" --step {step_id}
```

#### 步骤 2：按 gate 类型执行

**type: review（你来审查）**

脚本返回 `needs_llm: true` 和 `review_target`。你需要：

1. 根据 `review_target.type` 读取审查对象：
   - `"content"` → 读取产物文件
   - `"reference"` → 读取清单中 `review_target.files` 列出的每个项目文件
2. 按步骤指令中的完成条件逐项审查
3. 写入 gate 结果 JSON 到 `{gate_file}`：

```json
{
  "result": "pass",
  "score": 85,
  "findings": [
    {
      "severity": "medium",
      "title": "缺少示例代码",
      "detail": "第三节讨论了 API 但没有代码示例",
      "suggestion": "添加 2-3 个核心 API 的调用示例"
    }
  ],
  "reviewed_by": "workflow-orchestrator",
  "at": "{ISO timestamp}"
}
```

severity 规则：
- `critical` — 严重问题，必须修复（安全漏洞、逻辑错误、完全偏题）
- `high` — 重要问题，强烈建议修复
- `medium` — 改进建议
- `low` — 微小建议

**type: command（脚本自动执行）**

`gate.mjs run` 已经执行了命令并写入了结果，无需你操作。跳到步骤 3。

**type: tool（你调用 MCP 工具）**

脚本返回 `tool_name`。你调用该工具，将结果写入 `{gate_file}`。

**type: manual（用户审查）**

用 AskUserQuestion 展示产物摘要，询问用户是否通过。将结果写入 `{gate_file}`。

#### 步骤 3：获取 gate 判定

```bash
node engine/gate.mjs result --dir "{workflow_dir}" --step {step_id}
```

**返回**：`decision: pass` 或 `decision: fail`

**自动触发的 Hook**：
- Pass → `on_gate_pass`
- Fail → `on_gate_fail`

**下一步**：
- Pass → 进入 NEXT 阶段
- Fail → 进入 LOOP 阶段

---

### LOOP — 失败重试（仅 gate fail 时）

如果 `decision: fail` 且 `can_loop: true`：

```bash
node engine/loop.mjs iterate --dir "{workflow_dir}" --step {step_id}
```

**自动触发的 Hook**：
- 首次迭代 → `on_loop_start`
- 达到终止条件 → `on_loop_exit`

**三种结果**：

| 结果 | 动作 |
|------|------|
| `escalate: false` | 回到 START，带着 findings 重新执行步骤 |
| `escalate: true, reason: convergence_detected` | 告诉用户：同样的问题反复出现，询问是否继续、修改策略、或跳过 |
| `escalate: true, reason: max_iterations_reached` | 告诉用户：已达最大重试次数，询问是否跳过或放弃 |

**重试时**：将 gate findings 作为上下文传给步骤执行，明确告知"上次审查发现以下问题，请在本次执行中解决"。

如果 `decision: fail` 且 `can_loop: false`：

直接告诉用户 gate 失败的原因和 findings，用 AskUserQuestion 询问：
- 手动修复后重试
- 跳过此步骤继续
- 终止工作流

---

### NEXT — 推进到下一步

Gate 通过后（或用户决定跳过后）：

**1. 补充 Handoff（推荐）**

如果你在执行过程中积累了对下一步重要的隐性知识，补充 handoff：

```bash
node engine/handoff.mjs generate --dir "{workflow_dir}" --run "{run_id}" --step {step_id} --save '{"critical_context_for_next_step":["..."],"open_questions":["..."]}'
```

这些信息会自动传递给下一步的 CONTEXT LOADING 阶段。

**2. 展示步骤完成摘要**：

```
步骤 {step_name} 完成 ✓
Gate: {pass/fail/skip}  Score: {score}
产物: {artifact_path}

下一步: {next_step_name} — {next_step_description}
```

用 AskUserQuestion 确认是否继续下一步。

用户确认后：

1. 如果 `workflow_completed: true`：
   ```bash
   # on_workflow_complete hook 已在 gate.mjs result 中自动触发
   # 增量演化：每步完成时已自动提取该步经验（extract-step + inject）
   # 全量演化：workflow 完成时再次运行全量 extract + inject 作为兜底
   ```
   展示最终摘要，然后用 AskUserQuestion 询问用户是否存档：

   ```
   工作流已完成。是否将本次运行存档？
   - 存档并重置：将产物归档到 archives/run-{N}/，重置工作流状态，保留 step 文件中的经验积累，可以开始新一轮运行
   - 保持现状：不存档，保留当前状态
   ```

   如果用户选择存档，根据本次运行的工作内容总结一个简短描述作为 `--summary`：
   ```bash
   node engine/evolve.mjs archive --dir "{workflow_dir}" --summary "简短描述本次运行完成了什么"
   ```

2. 否则，回到 START 执行下一步。

---

## 关键约束

- **不要跳过 GATE**：即使你觉得产物质量很好，有 gate 就必须走 gate 流程
- **不要手动改状态**：所有状态变更通过 engine 脚本
- **失败时不要自作主张**：gate fail 后，要么走 loop，要么问用户，不要静默跳过
- **产物先于 complete**：必须先写完产物文件，再调 advance.mjs complete
- **不要手动触发 hooks**：所有 hooks 已在 engine 脚本中自动触发
- **增量演化自动运行**：每步 complete 后会自动提取该步经验并注入 step 文件，无需手动调用

---

## 忘记下一步怎么办？

**随时运行状态检查**：

```bash
node engine/advance.mjs status --dir "{workflow_dir}"
```

**返回示例**：

```json
{
  "ok": true,
  "workflow": "my-workflow",
  "status": "in_progress",
  "current_step": {
    "id": 3,
    "name": "draft",
    "status": "gate_pending",
    "instruction": "steps/step-03-draft.md",
    "has_artifact": true
  },
  "last_event": {
    "event": "gate_pending",
    "step": 3,
    "at": "2026-04-04T12:00:00Z"
  }
}
```

**根据状态决定下一步**：

| current_step.status | 下一步动作 |
|---------------------|-----------|
| `pending` | 调用 `advance.mjs start` |
| `in_progress` | 读指令文件 → 执行 → 写产物 → 调 `advance.mjs complete` |
| `gate_pending` | 调 `gate.mjs run` → 执行审查 → 调 `gate.mjs result` |
| `completed` | 调 `advance.mjs next` 获取下一步 |
