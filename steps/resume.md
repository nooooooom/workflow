---
name: resume
description: 恢复中断的工作流，校验状态并继续执行
---

# 恢复工作流

## 目标

从中断点恢复工作流执行。所有状态校验由 engine 脚本完成。

## 执行流程

### 1. 发现工作流

```bash
node engine/session.mjs list
```

返回所有工作流及其状态。如果有多个 `in_progress` 的工作流，用 AskUserQuestion 让用户选择。
如果只有一个，直接使用。

### 2. 获取状态

```bash
node engine/advance.mjs status --dir ".workflows/{name}"
```

返回：
- `status` — 工作流整体状态
- `current_step` — 当前步骤（id、name、status、has_artifact）
- `completed_steps` — 已完成步骤数
- `steps_summary` — 所有步骤状态一览
- `last_event` — 最后一个事件

### 2.5 补偿演化检查

检查是否有已完成步骤的经验未被提取（用户上次中途退出时可能遗漏）：

```bash
node engine/evolve.mjs status --dir ".workflows/{name}"
```

如果有已完成步骤但 `last_extracted` 为空或 `steps_with_lessons < completed_steps`，补跑一次全量提取：

```bash
node engine/evolve.mjs extract --dir ".workflows/{name}" --run "{run_id}"
node engine/evolve.mjs inject --dir ".workflows/{name}"
```

这确保即使上次会话中的增量演化因异常中断而遗漏，恢复时也能补偿提取。

### 3. 展示恢复摘要

```
检测到工作流：{name}

| # | 步骤 | 状态 |
|---|------|------|
| 1 | research | completed |
| 2 | draft | in_progress |
| 3 | review | pending |

当前位置：步骤 {current_step.name}（{current_step.status}）
已有产物：{current_step.has_artifact ? "是" : "否"}
```

### 4. 确定恢复策略

根据 `current_step.status` 决定恢复方式：

| 步骤状态 | 恢复策略 |
|----------|---------|
| `pending` | 正常开始：`advance.mjs start` |
| `in_progress` | 检查有无产物，有则继续到 complete，无则重新执行 |
| `gate_pending` | 直接运行 gate：`gate.mjs run` |
| `gate_failed` | 展示上次失败原因，询问用户是重试还是跳过 |
| `completed` | 查找下一个 pending 步骤 |

### 5. 用户确认

用 AskUserQuestion 询问：

```
options:
  - 从 {current_step.name} 继续（推荐）
  - 回退到 {earlier_step}
  - 重新初始化
```

### 6. 执行

用户确认后，读取 `steps/execute.md` 开始执行目标步骤。
