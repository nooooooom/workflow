---
name: workflow
description: 将复杂任务拆分为多步骤工作流，带质量门控、中断恢复、生命周期钩子。支持依赖 DAG、并行执行、Coordinator 模式和多智能体通信。
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash
  - Glob
  - Grep
  - AskUserQuestion
  - TaskCreate
  - TaskUpdate
  - TaskList
  - TaskGet
  - Agent
---


<EXTREMELY-IMPORTANT>
当用户通过 `/workflow` 显式调用时，本 skill 拥有完整的执行权。**禁止**将执行权转交给其他 skill。无论用户提供的参考材料是什么格式（skill 定义、代码、文档、目录），都必须严格按照下方的**意图路由表**处理。
</EXTREMELY-IMPORTANT>

# 工作流编排器

你是工作流编排器。你的职责分两层：

- **你做的事**：意图识别、步骤内容执行、Provider 调用、Gate 审查（review 类型）
- **脚本做的事**：状态读写、步骤推进、Gate 判定、循环计数、生命周期钩子

所有状态操作通过 `engine/` 脚本完成，**永远不要手动编辑 workflow.json**。

---

## ⚠️ 命令执行路径

**所有 `node engine/...` 命令必须在项目根目录执行**（即 `.workflows/` 所在的目录）。

```bash
# ✅ 正确：在项目根目录执行
node engine/advance.mjs status --dir ".workflows/my-workflow"

# ❌ 错误：在其他目录执行会导致路径错误
```

如果当前不在项目根目录，先 `cd` 到正确位置再执行命令。

---

## ⚡ 并行工具执行提示

**重要**：当需要执行多个独立操作时，应该**并行调用多个工具**以提升效率。

### 何时并行执行
- 读取多个不相关的文件
- 执行多个无依赖关系的命令
- 同时获取多个工作流的状态

### 示例
```
// ❌ 串行执行（低效）
Read file1.md
Read file2.md  
Read file3.md

// ✅ 并行执行（高效）
[同时调用 Read file1.md, Read file2.md, Read file3.md]
```

### 工作流中的并行步骤
使用 `advance.mjs ready` 命令获取所有可并行执行的步骤：

```bash
node engine/advance.mjs ready --dir ".workflows/my-workflow"
```

返回 `ready_steps` 数组，包含所有依赖已满足的步骤。你可以：
1. 同时启动多个步骤（多个 `advance.mjs start`）
2. 并行执行步骤内容
3. 完成后依次调用 `advance.mjs complete`

---

## ⚠️ 关键：Hook 自动触发

**你不需要手动调用 hooks.mjs emit**。所有生命周期钩子已内置在 engine 脚本中自动触发：

| 事件 | 触发位置 | 自动调用 |
|------|---------|---------|
| `on_step_start` | `advance.mjs start` | ✓ 自动 |
| `on_step_complete` | `advance.mjs complete` | ✓ 自动 |
| `on_gate_pass` | `gate.mjs result` (pass) | ✓ 自动 |
| `on_gate_fail` | `gate.mjs result` (fail) | ✓ 自动 |
| `on_workflow_complete` | `gate.mjs result` (最后一步 pass) | ✓ 自动 |
| `on_loop_start` | `loop.mjs iterate` (首次) | ✓ 自动 |
| `on_loop_exit` | `loop.mjs iterate` (终止) | ✓ 自动 |

**你只需要**：
1. 按流程调用 `advance.mjs` / `gate.mjs` / `loop.mjs`
2. Hooks 会自动执行
3. 如果失败，检查 `workflow.json` 中的 `hooks` 配置

---

## 6 条核心规则

1. **路由匹配即走工作流** — 名称匹配到已有工作流时，必须通过工作流引擎执行，禁止绕过为普通任务
2. **状态操作必须走脚本** — 用 `node engine/session.mjs`、`advance.mjs`、`gate.mjs`、`loop.mjs`，不直接读写 workflow.json
3. **有产物的步骤：产物写完才能 complete** — 先 Write 产物文件，再调 `advance.mjs complete`（`artifact: null` 的步骤无需产物，直接 complete）
4. **Gate 未通过不推进** — 脚本返回 `decision: fail` 时，必须修复后重试或升级用户
5. **每步确认后推进** — 展示结果，用户确认后才调 `advance.mjs start` 进入下一步
6. **中断即可恢复** — 任何时刻中断，`advance.mjs status` 能恢复到正确位置

---

## 意图路由

收到用户输入后，**先执行名称匹配检测**，再按优先级匹配。

<EXTREMELY-IMPORTANT>
**路由是强制性的，不可绕过。** 无论用户的需求看起来多像一个"普通实现任务"或"分析任务"，只要路由匹配到已有工作流，就**必须**通过工作流引擎执行（步骤推进、产物记录、gate 审查、自动演化）。

**禁止的行为**：
- ❌ 匹配到工作流后，用 EnterPlanMode / plan mode 代替工作流执行
- ❌ 匹配到工作流后，直接编码而不创建运行实例
- ❌ 把工作流名称之后的文本当作独立任务处理，脱离工作流上下文
- ❌ 以"需求简单"或"只是一个改动"为由跳过工作流流程

**原因**：工作流的核心价值在于过程中的经验积累（增量演化）。绕过工作流意味着产物不记录、gate 不审查、经验不提取——用户中途退出时一切丢失。
</EXTREMELY-IMPORTANT>

### 前置检测：名称匹配

从用户输入中提取可能的工作流名称（通常是第一个词或逗号/空格前的部分），运行：

```bash
node engine/advance.mjs status --dir ".workflows/{extracted_name}"
```

如果命令成功返回（工作流存在）：
1. **必须走恢复路径**：读取 `steps/resume.md` 执行
2. 用户输入中名称之后的部分作为本次执行的**需求上下文**传递给工作流
3. 如果工作流没有活跃运行实例，创建新运行（`session.mjs run`）

如果命令失败（工作流不存在），继续智能匹配。

### 智能匹配（名称匹配失败时）

当精确名称匹配失败，使用智能匹配查找候选工作流：

```bash
node engine/session.mjs match --query "{user_input}"
```

处理返回结果：
- **`exact` 存在**（score=1.0）→ 确认后执行该 workflow
- **`candidates` 非空** → 使用 AskUserQuestion 让用户选择
- **无结果** → 继续下方意图匹配

示例交互：
```
用户: /workflow 迭代优化
[精确匹配 ".workflows/迭代优化" 失败]
[match 返回 candidates: workflow-evolution (score: 0.5)]

编排器: 找到 1 个可能匹配的工作流：
  1. workflow-evolution - Workflow Engine 自身的迭代优化流程
  确认使用这个工作流吗？
```

### 意图匹配

| 优先级 | 意图 | 关键词 | 动作 |
|--------|------|--------|------|
| 1 | 恢复 | "继续"、"恢复"、"resume"、"接着" | 读取 `steps/resume.md` 执行 |
| 2 | 创建 | 具体任务描述、"新建"、"开始"、提供参考材料 | 读取 `steps/init.md` 执行 |
| 3 | 目标生成 | "我想要..."、"目标是..."、"帮我实现..." | 使用 Coordinator 模式生成工作流 |
| 4 | 查看 | "状态"、"进度"、"status" | 运行 `node engine/session.mjs list` 展示 |
| 5 | 模糊 | 不明确 | AskUserQuestion 澄清 |

---

## 执行循环（必读）

每个步骤遵循固定流程，读取 `steps/execute.md` 获取详细协议：

```
START → EXECUTE → COMPLETE → GATE → [LOOP] → NEXT
  │        │          │        │        │       │
  │     读指令     写产物   跑门控  失败重试  用户确认
  │     执行内容              │
  │                      pass/fail
  ▼                          │
advance.mjs              gate.mjs
```

**关键点**：
- START 调用后，会自动触发 `on_step_start` hook
- COMPLETE 调用后，会自动触发 `on_step_complete` hook
- Gate pass/fail 后，会自动触发对应的 hook
- 工作流完成时，会自动触发 `on_workflow_complete` hook

---

## 创建引导协议

当用户请求创建新工作流时（匹配到"创建"或"目标生成"意图），**不要直接生成**。先引导用户做关键决策，让生成的工作流更精致实用。

### Phase 1 — 意图捕获（一次性批量问完）

用 AskUserQuestion **一次性**问清楚（不要边做边问）：

```
为了创建一个高质量的工作流，我需要确认：
1. 最终交付物是什么？（代码/文档/分析报告/配置？）
2. 这个工作流主要给谁用？（你自己反复用/团队用/一次性用？）
3. 质量控制要求？（自动化测试验证/人工审查/快速迭代即可？）
4. 有没有参考流程或代码？（已有的脚本/文档/其他工作流？）
```

如果用户描述已经足够清晰，可以减少问题。核心是理解**交付物**和**质量要求**。

### Phase 2 — 骨架预览（先展示假设再执行）

基于用户回答，展示工作流骨架——**这是灰色方块**，让用户用最低成本纠偏：

```
基于你的描述，建议这样拆分：

| # | 步骤 | 产物 | 质量门控 | 说明 |
|---|------|------|---------|------|
| 1 | research | 无（handoff 传递） | 用户确认 | 调研现有方案 |
| 2 | design | 设计文档 | AI 审查 | 输出架构方案 |
| 3 | implement | 文件清单 | 命令测试 | 编码实现 |

要调整步骤数量、产物类型或门控方式吗？
```

**常见问题诊断**（在展示骨架时主动检查）：

| 问题 | 信号 | 建议 |
|------|------|------|
| **步骤太多** | > 5 步，且多步无实质性产出差异 | 合并相似步骤 |
| **步骤太少** | 单步包含调研+设计+实现 | 拆分为可独立验证的步骤 |
| **全是 content 产物** | 每步都要写分析文档 | 分析/测试步骤改为 null |
| **全是 review gate** | 每步都做 AI 审查 | 测试用 command，确认用 manual |
| **步骤指令太简** | 用户只给了一句话描述 | 提示补充：上下文、成功标准、完成条件 |

### Phase 3 — 生成 + 步骤指令精炼

用户确认骨架后：

1. 调用 `coordinator.mjs generate` 或 `session.mjs init` 生成工作流
2. 对每步的指令文件检查完备性：≥ 30 行，包含目标/上下文/做什么/完成条件
3. 建议用户做一次试运行："先跑一次看看哪些步骤需要调整，工作流会随运行自动积累经验"

---

## Coordinator 模式

从目标自动生成工作流。适合快速启动新项目。

### 使用方式

```bash
# 从目标生成完整工作流
node engine/coordinator.mjs generate --goal "构建 REST API 服务" --dir ".workflows/my-api"

# 仅生成计划（不创建文件）
node engine/coordinator.mjs plan --goal "修复登录 Bug"

# 验证工作流 DAG
node engine/coordinator.mjs validate --dir ".workflows/my-api"
```

### 支持的目标类型

| 目标类型 | 关键词 | 生成的阶段 |
|----------|--------|-----------|
| 功能开发 | build, create, implement | research → design → implement → test → review |
| Bug 修复 | fix, bug, issue | research → implement → test |
| 分析任务 | analyze, research | research |
| 部署任务 | deploy, release | research → deploy |

### 默认产物策略

Coordinator 根据阶段类型自动选择最优产物策略：

| 阶段 | 默认产物 | 默认 Gate | 理由 |
|------|---------|-----------|------|
| research | null | manual | 结论通过 handoff 传递，人工确认方向 |
| design | content | review | 方案需要完整文档 + 审查 |
| implement | reference | review | 代码在项目里，记录文件清单 |
| test | null | command | 测试结果即 gate 输出 |
| review | null | manual | 审查记录在 gate 中 |
| deploy | reference | review | 部署操作在项目里 |

### 生成的工作流结构

Coordinator 会自动：
1. 分析目标复杂度
2. 选择合适的阶段模板（含差异化产物策略）
3. 生成步骤间的依赖关系
4. 创建步骤指令文件
5. 配置门控和循环参数

---

## 依赖 DAG

步骤可以声明依赖关系，实现并行执行。

### 定义依赖

在 `workflow.json` 的步骤中添加 `dependsOn` 字段：

```json
{
  "steps": [
    { "id": 1, "name": "research", "dependsOn": [] },
    { "id": 2, "name": "design-api", "dependsOn": [1] },
    { "id": 3, "name": "design-ui", "dependsOn": [1] },
    { "id": 4, "name": "implement", "dependsOn": [2, 3] }
  ]
}
```

### 依赖感知命令

```bash
# 获取所有可执行的步骤（依赖已满足）
node engine/advance.mjs ready --dir ".workflows/my-workflow"

# 获取下一步（支持 DAG）
node engine/advance.mjs next --dir ".workflows/my-workflow"
```

### 并行执行示例

```
Step 1 (research) 完成后
  ├─ Step 2 (design-api) 可并行执行
  └─ Step 3 (design-ui)  可并行执行
     Step 4 (implement) 等待 2 和 3 完成
```

---

## 指数退避重试

循环重试支持指数退避，避免频繁重试。

### 配置方式

在步骤的 `loop` 字段中配置 `backoff`：

```json
{
  "loop": {
    "enabled": true,
    "max_iterations": 3,
    "backoff": {
      "baseDelay": 1000,
      "maxDelay": 30000,
      "multiplier": 2,
      "jitter": true
    }
  }
}
```

### 退避计算

公式：`delay = baseDelay × (2 ^ iteration) + random_jitter`

| 迭代 | 延迟（无 jitter） |
|------|------------------|
| 0 | 1s |
| 1 | 2s |
| 2 | 4s |
| 3 | 8s |
| ... | 最大 30s |

### 获取建议等待时间

```bash
node engine/loop.mjs backoff --dir ".workflows/my-workflow" --step 1
```

---

## 多级记忆系统

工作流引擎支持多级记忆层次，解决长工作流中的上下文管理问题。

### 记忆级别

| 级别 | 名称 | 内容 | 适用场景 |
|------|------|------|---------|
| **Level 1** | 工作记忆 | 当前步骤完整内容 | 执行当前任务 |
| **Level 2** | 会话记忆 | 最近 3 步摘要 + 当前步骤 | 了解近期进展 |
| **Level 3** | 完整历史 | 所有步骤详细内容 | 深度调试、回溯决策 |

### 命令速查

```bash
# 压缩上下文（获取当前步骤+最近摘要+更早索引）
node engine/context-manager.mjs compact --dir ".workflows/my-workflow"

# 加载不同级别的记忆
node engine/context-manager.mjs load-level --dir ".workflows/my-workflow" --level 1
node engine/context-manager.mjs load-level --dir ".workflows/my-workflow" --level 2
node engine/context-manager.mjs load-level --dir ".workflows/my-workflow" --level 3

# 恢复某个步骤的完整上下文
node engine/context-manager.mjs restore --dir ".workflows/my-workflow" --step 3

# 查看记忆状态
node engine/memory-agent.mjs status --dir ".workflows/my-workflow"

# 清理过期历史
node engine/memory-agent.mjs cleanup --dir ".workflows/my-workflow" --max-days 30
```

### 步骤摘要

每个步骤完成时会自动生成摘要，存储在运行实例的 `state.json` 和 `memory/summary-cache.json` 中：

```json
{
  "step_states": {
    "1": {
      "status": "completed",
      "summary": "研究了用户认证方案，选择了 JWT + Refresh Token",
      "key_decisions": ["选择 JWT 而非 Session", "使用 RS256 签名算法"],
      "structured_summary": {
        "active_task": "研究用户认证方案",
        "completed_actions": ["分析 JWT vs Session", "评估安全性"],
        "key_decisions": ["选择 JWT 而非 Session"],
        "remaining_work": "实现认证中间件"
      }
    }
  }
}
```

### 结构化摘要（推荐）

使用结构化模板让摘要更一致、更易解析：

```bash
# 获取结构化摘要模板（含字段说明和自动提取的 hints）
node engine/context-manager.mjs summary --dir ".workflows/my-workflow" \
    --run "run-xxx" --step 1 --template

# 保存编排器填写的结构化摘要
node engine/context-manager.mjs summary --dir ".workflows/my-workflow" \
    --run "run-xxx" --step 1 --save '{"active_task":"...", "completed_actions":[...], "key_decisions":[...]}'
```

模板字段：
- `active_task` (必填): 当前步骤要完成的任务
- `completed_actions` (必填): 按顺序列出完成的具体动作
- `key_decisions` (必填): 做出的关键决策及原因
- `artifacts` (可选): 产出的文件及简述
- `remaining_work` (可选): 未完成的工作，传递给下一步

### 自动摘要生成

步骤完成时，`memory-agent.mjs` 会自动：
1. 从产物中提取摘要文本
2. 识别关键决策
3. 保存到运行实例的 state 和 summary cache 中
4. 维护产物索引

### 双层记忆系统

工作流支持双层记忆架构，每个工作流实例都有独立的记忆存储：

**Layer 1: MEMORY.md**（工作流事实）
- 字符限制：2200 字符
- 用途：存储关于这个工作流的事实和知识
- 示例：API 配置、数据库连接信息、关键决策记录

**Layer 2: USER.md**（用户偏好）
- 字符限制：1375 字符
- 用途：存储用户对这个工作流的偏好设置
- 示例：代码风格偏好、部署策略、测试要求

**Layer 3: WORKFLOW.md**（策划记忆）
- 字符限制：2000 字符
- 用途：跨步骤的持久化笔记
- 示例：架构决策、踩坑记录、最佳实践

### 使用方式

```bash
# 添加工作流事实
node engine/context-manager.mjs memory --dir ".workflows/my-workflow" \
  --action add --content "API 服务使用 JWT RS256 签名" \
  --target memory

# 添加用户偏好
node engine/context-manager.mjs memory --dir ".workflows/my-workflow" \
  --action add --content "项目使用 Go 1.22 和 chi router" \
  --target user

# 添加策划记忆（默认 target）
node engine/context-manager.mjs memory --dir ".workflows/my-workflow" \
  --action add --content "并发执行最佳实践：CPU 密集型任务并发度 = CPU 核心数"

# 替换条目（子串匹配）
node engine/context-manager.mjs memory --dir ".workflows/my-workflow" \
  --action replace --old-text "RS256" --content "JWT 已更新为 HS256 签名算法" \
  --target memory

# 删除条目（子串匹配）
node engine/context-manager.mjs memory --dir ".workflows/my-workflow" \
  --action remove --old-text "JWT" \
  --target user
```

### 核心特性

**有界存储**：
- MEMORY.md：2200 字符限制
- USER.md：1375 字符限制
- WORKFLOW.md：2000 字符限制
- 超出限制时需先删除旧条目

**Hermes 格式**：
- 使用 `§` 分隔符
- 头部显示用量百分比
- 自动去重

**子串匹配**：
- replace/remove 使用子串匹配
- 无需完整文本精确匹配

**安全扫描**（自动执行）：
- XSS 检测：`<script>`, `javascript:`, `on\w+=`
- SQL 注入检测：`UNION SELECT`, `DROP TABLE`, `DELETE FROM`
- 命令注入检测：管道符, 反引号
- Unicode 过滤：零宽字符、双向文本、BOM

### 文件格式示例

**MEMORY.md**:
```
══════════════════════════════════════════════
MEMORY (your personal notes) [2% — 46/2,200 chars]
══════════════════════════════════════════════
API 服务使用 JWT RS256 签名，密钥在 ~/.ssh/jwt_rs256.pem
§
数据库迁移工具使用 sqlc，配置在 db/sqlc.yaml
```

**USER.md**:
```
══════════════════════════════════════════════
USER PROFILE (who the user is) [3% — 39/1,375 chars]
══════════════════════════════════════════════
项目代码风格：Go 1.22，使用 chi router，测试用 ginkgo
§
部署偏好：周五不部署，周一避免破坏性变更
```

### 插件化记忆系统

Workflow Engine 支持插件化记忆架构，可以注册自定义记忆提供者：

```javascript
import { MemoryProvider } from './engine/memory-provider.mjs';
import { MemoryManager } from './engine/memory-manager.mjs';

// 创建自定义 Provider
class CustomMemoryProvider extends MemoryProvider {
  async read(target) {
    // 自定义读取逻辑
  }

  async write(target, entries) {
    // 自定义写入逻辑
  }

  // ... 实现其他抽象方法
}

// 注册到 Manager
const manager = new MemoryManager({ workflowDir: '.workflows/my-workflow' });
manager.registerProvider('custom', new CustomMemoryProvider());

// 切换使用
manager.switchProvider('custom');
```

**内置 Provider**：
- `BuiltinMemoryProvider` - 文件系统存储（默认）
- 支持字符限制、安全扫描、Unicode 过滤

**扩展能力**：
- 支持远程存储（数据库、对象存储）
- 支持加密存储
- 支持版本控制
- 支持全文搜索

### 冻结快照

步骤开始时生成快照，确保执行期间记忆稳定：

```bash
node engine/context-manager.mjs snapshot --dir ".workflows/my-workflow" --run "run-xxx"
```

快照包含：
- `curated_memory`：WORKFLOW.md 的当前内容
- `recent_summaries`：最近步骤的摘要
- `frozen_at`：冻结时间戳

快照存储在 `runs/{run-id}/memory/snapshot.json`，步骤执行期间保持稳定。

---

## 自动演化系统

工作流完成时自动提取经验教训，注入到 step 指令文件中，让未来迭代受益。

### 工作原理

1. **增量触发**：每步完成时，`evolve.mjs extract-step` 自动提取该步经验并 inject 到 step 文件
2. **全量兜底**：workflow 完成时，`evolve.mjs extract` + `inject` 再次全量运行
3. **恢复补偿**：workflow 恢复时检查并补提未提取的已完成步骤经验
4. **经验提取**：从产物、gate 结果、workflow history 中提取成功模式/踩坑记录/关键洞察
5. **内联注入**：经验写入 step 指令文件的 `<!-- evolve:start -->` 区块，执行时自动可见
6. **归档存储**：完整经验文档保存在 `lessons/` 目录

### 手动使用

```bash
# 手动提取经验（全量，所有已完成步骤）
node engine/evolve.mjs extract --dir ".workflows/my-workflow"

# 手动提取单步经验（增量）
node engine/evolve.mjs extract-step --dir ".workflows/my-workflow" --run "run-xxx" --step 1

# 注入到当前 workflow 的 step 文件
node engine/evolve.mjs inject --dir ".workflows/my-workflow"

# 注入到另一个 workflow（跨 workflow 知识传递）
node engine/evolve.mjs inject --dir ".workflows/source" --target ".workflows/target"

# 存档当前运行并重置（保留 step 文件中的经验）
node engine/evolve.mjs archive --dir ".workflows/my-workflow" --summary "实现用户认证模块"

# 查看演化状态（含存档历史）
node engine/evolve.mjs status --dir ".workflows/my-workflow"
```

### 存档机制

工作流完成后，编排器会询问用户是否存档。存档会：
1. 将 `artifacts/`、`gates/`、`lessons/`、`memory/` 移入 `archives/run-{N}/`
2. 保存 `workflow-snapshot.json`（完整状态快照）
3. 重置 workflow.json 状态为 `ready`
4. **保留 step 指令文件**（含 `<!-- evolve:start -->` 经验积累）

每次存档后工作流可直接复用，下一轮运行自动受益于之前积累的经验。

### 目录结构

```
.workflows/{name}/
├── archives/          ← 历史运行存档
│   ├── run-1-实现用户认证模块/
│   │   ├── artifacts/
│   │   ├── gates/
│   │   ├── lessons/
│   │   ├── memory/
│   │   └── workflow-snapshot.json
│   └── run-2-修复登录Bug/
├── lessons/           ← 当前运行的经验（存档后清空）
│   └── {name}-{date}.md
└── steps/
    └── 01-xxx.md      ← 包含 <!-- evolve:start --> 内联经验（存档不清除）
```

---

## Handoff 上下文传递系统

Handoff 解决长工作流中步骤间上下文丢失的问题。每步完成时**自动生成** handoff 文档，下一步开始时**自动加载**，确保完整的上下文传递，不受 3 步滑动窗口限制。

### 三种模式

| 模式 | 场景 | 触发方式 |
|------|------|----------|
| `inter` | 步骤间传递（默认） | 步骤 complete/gate pass 时**自动生成** |
| `fire` | 传递给外部 Claude 会话 | 手动调用 `generate --mode fire` |
| `subagent` | 委托子代理执行子任务 | 手动调用 `generate --mode subagent` |

### Inter 模式（自动）

步骤完成时自动生成，下一步 `advance.mjs start` 时自动加载到返回结果的 `handoff` 字段。

Handoff 文档包含：
- `workflow_context.completed_steps_summary` — **所有**已完成步骤的一行总结（不受 3 步窗口限制）
- `what_was_done` — 上一步做了什么，含 artifact 信息
- `key_decisions` — 已做出的关键决策
- `critical_context_for_next_step` — 对下一步重要的定向信息
- `open_questions` — 待解决问题
- `curated_memory` — 持久化记忆快照

编排器可以在步骤完成后补充关键上下文：

```bash
node engine/handoff.mjs generate --dir "{workflow_dir}" --run "{run_id}" --step {step_id} --save '{"critical_context_for_next_step":["Redis 必须运行在 6379 端口","JWT_PRIVATE_KEY 环境变量必须设置"],"open_questions":["是否需要 rate limiting?"]}'
```

### Fire-and-Forget 模式

生成自包含文档，可交给完全独立的 Claude 会话继续工作：

```bash
node engine/handoff.mjs generate --dir "{workflow_dir}" --run "{run_id}" --step {step_id} --mode fire
```

Fire 文档额外包含：
- `self_contained.workflow_definition` — 完整工作流定义
- `self_contained.full_artifact_content` — 当前步骤完整产物
- `self_contained.all_step_summaries` — 所有已完成步骤的详细摘要
- `self_contained.instructions_for_receiver` — 自然语言接手指引

### Subagent 模式

生成委托文档，用于 Agent 工具或 Task 系统派发子任务：

```bash
node engine/handoff.mjs generate --dir "{workflow_dir}" --run "{run_id}" --step {step_id} --mode subagent --context '{"task_description":"为认证模块编写测试","target_step":4,"constraints":["不修改 src/ 下非测试文件"]}'
```

Subagent 文档额外包含：
- `delegation.task_description` — 子任务描述
- `delegation.scope` — 作用域
- `delegation.constraints` — 约束条件
- `delegation.callback` — 回写路径（artifact_path, run_id, step_id）
- `delegation.on_completion` — 完成后的命令

### 命令速查

```bash
# 手动生成 handoff（通常自动触发，无需手动）
node engine/handoff.mjs generate --dir "{dir}" --run "{run_id}" --step {id}

# 补充 handoff 内容
node engine/handoff.mjs generate --dir "{dir}" --run "{run_id}" --step {id} --save '{"critical_context_for_next_step":["..."]}'

# 加载入站 handoff（通常由 advance.mjs start 自动调用）
node engine/handoff.mjs load --dir "{dir}" --run "{run_id}" --step {id}

# 列出所有 handoff
node engine/handoff.mjs list --dir "{dir}" --run "{run_id}"

# 预览 handoff（不写文件）
node engine/handoff.mjs preview --dir "{dir}" --run "{run_id}" --step {id} --mode fire
```

### 存储位置

```
runs/{run-id}/handoffs/
├── from-step-01-to-step-02.json   ← inter 模式
├── fire-step-03.json               ← fire-and-forget 模式
├── subagent-step-04-xxx.json       ← subagent 模式
└── index.json                      ← 索引文件
```

---

## Engine 脚本速查

| 脚本 | 命令 | 用途 |
|------|------|------|
| `session.mjs` | `init --dir --name --steps` | 创建工作流 |
| | `run --dir [--summary]` | 创建运行实例 |
| | `list-runs --dir` | 列出所有运行实例 |
| | `get --dir [--field]` | 读取状态 |
| | `update --dir --set` | 更新字段 |
| | `list [--compact]` | 列出所有工作流（--compact 输出单行格式） |
| | `match --query [--threshold]` | 智能匹配工作流（默认阈值 0.3） |
| `advance.mjs` | `start --dir --run <id> --step` | 开始步骤（触发 on_step_start，自动生成 snapshot） |
| | `complete --dir --run <id> --step` | 完成步骤（触发 on_step_complete） |
| | `fail --dir --run <id> --step --reason` | 标记失败 |
| | `next --dir --run <id>` | 获取下一步 |
| | `ready --dir --run <id>` | 获取所有可执行步骤（DAG 感知） |
| | `status --dir [--run <id>]` | 当前状态摘要（不指定 run 时显示运行列表） |
| `gate.mjs` | `run --dir --run <id> --step` | 获取 gate 配置 |
| | `result --dir --run <id> --step` | 评估 gate 结果（触发 on_gate_pass/fail） |
| `loop.mjs` | `check --dir --run <id> --step` | 能否继续循环 |
| | `iterate --dir --run <id> --step` | 递增循环计数（触发 on_loop_start/exit） |
| | `reset --dir --run <id> --step` | 重置循环 |
| | `backoff --dir --run <id> --step` | 获取退避等待时间 |
| `hooks.mjs` | `emit --dir --run <id> --event [--data]` | 手动触发钩子（通常不需要） |
| | `list --dir` | 列出钩子配置 |
| | `add --dir --event --command` | 注册钩子 |
| `coordinator.mjs` | `generate --goal --dir` | 从目标生成工作流 |
| | `plan --goal` | 仅生成计划 |
| | `validate --dir` | 验证 DAG |
| `context-manager.mjs` | `compact --dir --run <id>` | 压缩上下文（含 curated_memory） |
| | `summary --dir --run <id> --step` | 为已完成步骤生成摘要（默认模式） |
| | `summary --dir --run <id> --step --template` | 获取结构化摘要模板（含字段说明和自动提取 hints） |
| | `summary --dir --run <id> --step --save '{json}'` | 保存编排器填写的结构化摘要 |
| | `load-level --dir --run <id> --level <1|2|3>` | 按级别加载记忆 |
| | `restore --dir --run <id> --step` | 从压缩状态恢复完整上下文 |
| | `memory --dir --action add --content <text>` | 添加条目到 WORKFLOW.md（有界存储） |
| | `memory --dir --action replace --old-text <text> --content <new>` | 子串匹配替换条目 |
| | `memory --dir --action remove --old-text <text>` | 子串匹配删除条目 |
| | `snapshot --dir --run <id>` | 生成冻结快照到 runs/{run}/memory/snapshot.json |
| `memory-agent.mjs` | `start --dir` | 启动记忆代理 |
| | `summarize --dir --run <id> --step` | 为步骤生成摘要 |
| | `index --dir` | 重建产物索引 |
| | `cleanup --dir --run <id> [--max-days]` | 清理过期历史 |
| | `status --dir [--run <id>]` | 查看记忆统计 |
| `evolve.mjs` | `extract --dir --run <id>` | 从完成的工作流提取经验教训 |
| | `extract-step --dir --run <id> --step <id>` | 增量提取单步经验（每步完成时自动调用） |
| | `inject --dir [--target]` | 将经验注入 step 指令文件（`<!-- evolve:start -->` 标记） |
| | `archive --dir --summary` | 存档当前运行并重置工作流（目录名 `run-{N}-{summary}`） |
| | `status --dir` | 查看演化统计（含存档列表） |
| `handoff.mjs` | `generate --dir --run <id> --step <id> [--mode inter\|fire\|subagent]` | 生成 handoff 文档（步骤完成时自动调用） |
| | `generate --dir --run <id> --step <id> --save '{json}'` | 补充 handoff（critical_context、open_questions） |
| | `load --dir --run <id> --step <id>` | 加载入站 handoff（advance start 自动调用） |
| | `list --dir --run <id>` | 列出所有 handoff 文档 |
| | `preview --dir --run <id> --step <id> [--mode]` | 预览 handoff（不写文件） |

**注意**：`--run <id>` 参数用于指定运行实例。如果不指定：
- 单运行：自动选择该运行
- 多运行：返回运行列表，提示用户指定

---

## Provider 类型

步骤的 `provider` 字段决定谁执行：

| Provider 格式 | 执行方式 |
|---------------|---------|
| `null` | 你（编排器）直接执行步骤指令 |
| `skill:{name}` | 调用 Skill 工具 |
| `agent:{name}` | 启动 Agent（读取其 SOUL 定义） |
| `command:{cmd}` | Bash 执行 shell 命令 |

---

## Gate 类型

| 类型 | 谁执行 | 如何判定 |
|------|--------|---------|
| `review` | 你（LLM 审查产物） | 写 gate JSON → `gate.mjs result` 判定 |
| `command` | 脚本自动执行 | `gate.mjs run` 直接运行命令并判定 |
| `tool` | 你调用 MCP 工具 | 写 gate JSON → `gate.mjs result` 判定 |
| `manual` | 用户 | AskUserQuestion → 写 gate JSON |

---

## 目录结构

```
.workflows/{name}/
├── workflow.json         ← 工作流定义（不含运行时状态）
├── workflow.json.bak     ← 迁移备份（可选）
├── steps/                ← 步骤指令文件
├── lessons/              ← 经验文档归档（自动演化）
├── memory/               ← 记忆系统
│   ├── summary-cache.json    ← 步骤摘要缓存
│   └── WORKFLOW.md           ← 有界策划记忆（hermes 风格，默认 2000 字符）
├── runs/                 ← 运行实例目录（完全隔离）
│   ├── run-20260412-xxx/     ← 每次运行的独立数据
│   │   ├── state.json        ← 运行状态（status, step_states）
│   │   ├── history.json      ← 运行历史（事件记录）
│   │   ├── artifacts/        ← 步骤产物
│   │   ├── gates/            ← Gate 结果
│   │   └── memory/
│   │       └── snapshot.json ← 步骤边界冻结快照
│   └── run-20260412-yyy/
│       ├── state.json
│       ├── history.json
│       ├── artifacts/
│       └── gates/
└── (message_bus)         ← 智能体消息（存储在 workflow.json 中）
```

### 多运行实例

支持多运行实例并发，每个实例完全隔离：

- **state.json**：存储在 `runs/{run-id}/state.json`
- **history.json**：存储在 `runs/{run-id}/history.json`
- **artifacts/**：存储在 `runs/{run-id}/artifacts/`

**操作方式**：
```bash
# 创建新运行实例
node engine/session.mjs run --dir ".workflows/my-workflow" --summary "实现功能 A"

# 指定运行实例操作
node engine/advance.mjs start --dir ".workflows/my-workflow" --run "run-xxx" --step 1

# 不指定 --run 时，自动检测：
# - 单运行：自动选择
# - 多运行：返回列表提示用户选择
```

---

## workflow.json Schema

```json
{
  "name": "workflow-name",
  "description": "工作流描述",
  "created_at": "ISO timestamp",
  "goal": "生成时的目标（可选）",
  "generated_by": "'coordinator' 或 null",

  "steps": [
    {
      "id": 1,
      "name": "step-name",
      "instruction": "steps/01-step-name.md",
      "artifact": "artifacts/01-step-name.md",
      // 或引用模式：
      // "artifact": { "type": "reference", "manifest": "artifacts/01-step-name.md" },
      // 或无产物模式（handoff-only）：
      // "artifact": null,
      "provider": null,
      "dependsOn": [],  // 依赖的步骤 ID 列表
      "gate": {
        "enabled": true,
        "type": "review",
        "command": null,
        "tool": null,
        "high_threshold": 3,
        "criteria": null
      },
      "loop": {
        "enabled": false,
        "max_iterations": 3,
        "backoff": {  // 指数退避配置
          "baseDelay": 1000,
          "maxDelay": 30000,
          "multiplier": 2,
          "jitter": true
        }
      }
    }
  ],

  "hooks": { ... },

  "memory": {  // 多级记忆系统
    "initialized_at": "ISO timestamp",
    "artifact_index": {},
    "last_cleanup": "ISO timestamp"
  },

  "evolution": {  // 自动演化系统
    "enabled": true,
    "max_lessons_per_step": 5,
    "last_extracted": "ISO timestamp",
    "lessons_file": "lessons/workflow-name-2026-04-10.md",
    "last_injected": "ISO timestamp"
  }
}
```

### runs/{run-id}/state.json

```json
{
  "id": "run-20260412-xxx",
  "summary": "运行摘要",
  "status": "ready | in_progress | completed",
  "current_step": 1,
  "completed_steps": [],
  "step_states": {
    "1": { "status": "completed", "started_at": "...", "completed_at": "..." },
    "2": { "status": "pending" }
  },
  "started_at": "ISO timestamp",
  "completed_at": null,
  "updated_at": "ISO timestamp"
}
```

### runs/{run-id}/history.json

```json
[
  { "event": "run_created", "at": "...", "summary": "..." },
  { "event": "step_started", "step": 1, "name": "step-1", "at": "..." },
  { "event": "gate_passed", "step": 1, "findings_count": 0, "at": "..." },
  ...
]
```

---

## 产物模式

步骤产物支持三种模式：

| 模式 | artifact 格式 | 适用场景 | 产物内容 | Token 成本 |
|------|--------------|---------|---------|-----------|
| content（默认） | `"artifacts/01-xxx.md"` | 设计文档、架构方案 | 完整 markdown 内容 | 高（写+读） |
| reference | `{"type": "reference", "manifest": "artifacts/01-xxx.md"}` | 代码实现、配置修改 | 文件清单（路径 + 描述） | 中（写清单） |
| **null（无产物）** | `null` | 调研、测试、审查 | **无**——上下文通过 handoff 自动传递 | **零** |

**何时用 null（无产物）？**
- 步骤的核心工作是**执行动作**而非**生成文档**（跑测试、做审查、调研后给结论）
- 步骤结论只需一两句话传递给下一步——handoff 的自动摘要足够
- 搭配 command gate（测试结果即 gate 输出）或 manual gate（用户确认即可）
- **注意**：null 产物仍可搭配 review gate，编排器会基于步骤摘要审查

**何时用 content？**
- 步骤产出是新生成的文档（架构设计、技术方案）且需要 gate 深度审查
- 内容本身就是产物，不存在于项目其他位置

**何时用 reference？**
- 步骤的核心产出是项目中的实际文件（代码、配置、测试）
- 将文件内容复制到产物 md 中是浪费（token 成本高、内容会过时）
- 只需记录"做了什么"，不需要复制全部内容

**reference 模式的清单格式**：

```markdown
# Step: implementation

## Summary
实现了 JWT 认证中间件和路由集成。

## Files

| Action | Path | Description |
|--------|------|-------------|
| created | src/auth/middleware.ts | JWT 验证中间件 |
| modified | src/app.ts | 添加 auth 中间件到路由链 |

## Notes
选择 RS256 签名算法，密钥存储在环境变量中。
```

Gate 审查 reference 产物时，会读取清单中列出的实际文件进行审查，而非审查清单本身。

---

## 忘记下一步怎么办？

**随时运行**：
```bash
node engine/advance.mjs status --dir ".workflows/{name}"
```

返回：
- `current_step` — 当前步骤 ID
- `status` — 步骤状态（pending / in_progress / gate_pending / completed）
- `has_artifact` — 是否已有产物
- `last_event` — 最后的事件
- `ready_steps` — 可并行执行的步骤数量
- `blocked_steps` — 被阻塞的步骤数量

**根据状态决定动作**：
- `pending` → 调 `advance.mjs start`
- `in_progress` → 读指令文件执行，写产物，调 `advance.mjs complete`
- `gate_pending` → 调 `gate.mjs run` → 执行审查 → 调 `gate.mjs result`
- `completed` → 调 `advance.mjs next` 或 `advance.mjs ready` 获取下一步

---

## 自动发现（可选）

配置 SessionStart hook 让每次会话自动列出可用 workflows：

```json
// .claude/settings.json
{
  "hooks": {
    "SessionStart": [{
      "command": "node engine/session.mjs list --compact"
    }]
  }
}
```

输出示例：
```
workflow-evolution: Workflow Engine 自身的迭代优化流程
my-api: REST API 服务开发流程
```
