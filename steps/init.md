---
name: init
description: 从用户输入创建工作流：识别意图、提取步骤、调用 engine 初始化
---

# 创建工作流

## 目标

将用户输入转化为可执行的工作流。

## 输入类型

用户可能给你以下任何一种输入：

| 输入类型 | 示例 | 你的处理方式 |
|----------|------|-------------|
| **参考材料** | 一篇论文写作指南文章 | 提取文章中的核心步骤 |
| **任务描述** | "帮我开发一个登录页面" | 根据任务拆解步骤 |
| **能力清单** | "我有 code-reviewer agent 和 TDD skill" | 围绕这些能力编排工作流 |

## 执行流程

### 1. 意图理解

分析用户输入，判断属于哪种输入类型。如果不确定，用 AskUserQuestion 澄清。

### 2. 步骤提取

根据输入类型提取步骤：

**从参考材料提取：**
- 阅读全文，识别核心阶段/步骤
- 每个步骤需要有：名称、目标、完成条件
- 保持原文的逻辑顺序
- 合并过于细碎的步骤，拆分过于笼统的步骤

**从任务描述推导：**
- 分析任务需要哪些阶段
- 常见模式：调研 → 设计 → 实现 → 验证

**从能力清单编排：**
- 分析每个 Providers 的能力
- 按合理顺序串联
- 确定每步的 provider

### 3. 设计确认

向用户展示工作流设计：

```
## 工作流设计：{name}

| # | 步骤 | 描述 | Provider | 门控 |
|---|------|------|----------|------|
| 1 | research | 调研背景资料 | null | review |
| 2 | outline | 拟定大纲 | null | review |
| 3 | draft | 撰写初稿 | null | review |
| 4 | publish | 发布 | null | 无 |

确认按此设计创建？
```

用 AskUserQuestion 获得确认。**未经确认不创建任何文件。**

### 4. 生成步骤指令文件

用户确认后，为每个步骤在 `.workflows/{name}/steps/` 下创建指令文件：

文件名格式：`{NN}-{name}.md`（NN 为两位数序号）

```markdown
---
name: '{step_name}'
description: '{step_description}'
---

# {step_name}

## 步骤目标
{从用户输入推导的具体目标}

## 执行要求
{具体的执行指南、约束、参考信息}

## 完成条件
- {明确的验收标准}

## 产物
- 输出文件：`artifacts/{NN}-{name}.md`
```

### 5. 调用 Engine 初始化

构建 steps JSON 数组，调用：

```bash
node engine/session.mjs init \
  --dir ".workflows/{name}" \
  --name "{name}" \
  --description "{description}" \
  --steps '[
    {
      "name": "research",
      "gate": {"enabled": true, "type": "review"},
      "loop": {"enabled": false}
    },
    {
      "name": "draft",
      "gate": {"enabled": true, "type": "review"},
      "loop": {"enabled": true, "max_iterations": 3}
    },
    {
      "name": "publish",
      "gate": {"enabled": false}
    }
  ]'
```

**gate 配置指南：**
- 需要质量审查的步骤：`{"enabled": true, "type": "review"}`
- 有自动化检查脚本的步骤：`{"enabled": true, "type": "command", "command": "npm test"}`
- 最终发布/部署步骤：`{"enabled": false}`
- 需要人工确认的步骤：`{"enabled": true, "type": "manual"}`

**loop 配置指南：**
- 创意性步骤（写作、设计）：`{"enabled": true, "max_iterations": 3}`
- 一次性步骤（调研、发布）：`{"enabled": false}`

### 6. 展示结果并开始

```
工作流 "{name}" 已创建 ✓

已生成文件：
- .workflows/{name}/workflow.json
- .workflows/{name}/steps/01-research.md
- .workflows/{name}/steps/02-draft.md
- ...

准备开始第一步：{first_step_name}
```

用 AskUserQuestion 询问是否开始。用户确认后，读取 `steps/execute.md` 开始执行第一步。

## 注意事项

- 步骤数量建议 3-8 个，过少无法体现工作流价值，过多管理成本高
- 每步的指令文件要足够具体，让 LLM 在没有额外上下文时也能执行
- 如果用户提供了 Agent/Skill，在 steps JSON 中设置对应的 `provider` 字段
