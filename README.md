# Workflow

**可演化、最终自治的 AI 工作流引擎。**

基于 [Anthropic Harness Design](https://www.anthropic.com/research/harness-design) 构建，将复杂任务拆分为多步骤工作流，每步带质量门控、中断恢复和经验积累。

---

## 这是什么？

Workflow 是一个工作流编排系统。它解决的核心问题是：**AI 执行复杂多步任务时，如何保证每步质量、支持中断恢复、并从历史经验中持续改进。**

你可以用它来：
- 把"实现用户认证系统"这样的大任务拆成：需求分析 → 架构设计 → 编码实现 → 测试 → 文档更新
- 每步完成后自动进行质量审查（Gate），不达标则自动重试
- 中途关掉终端，下次打开继续执行
- 同一个工作流模板反复使用，每次运行的经验自动积累到下一次

---

## 特性

- **门控驱动** -- 每步独立验证，质量保证内建
- **状态持久化** -- 随时中断，随时恢复
- **运行实例隔离** -- 多运行并发，产物完全隔离
- **Harness 核心** -- Evaluator 独立于 Generator，避免自我评估偏差
- **无限扩展** -- Hooks + 自定义 Provider，任意扩展
- **自动演化** -- 经验自动提取与注入，持续改进

---

## 核心概念

### 工作流 = 模板 + 运行实例

一个工作流定义（`workflow.json`）是模板，不包含运行时状态。每次执行创建一个**运行实例**，所有状态、产物、历史记录都存在运行实例的独立目录中：

```
.workflows/my-feature/
├── workflow.json         # 工作流模板定义
├── steps/                # 步骤指令文件（模板的一部分）
│   ├── 01-research.md
│   ├── 02-design.md
│   └── 03-implement.md
├── lessons/              # 经验文档（跨运行积累）
├── memory/               # 记忆系统
└── runs/                 # 运行实例（每次执行独立）
    ├── run-20260412-实现A/
    │   ├── state.json    # 运行状态
    │   ├── history.json  # 事件历史
    │   ├── artifacts/    # 步骤产物
    │   └── gates/        # 门控结果
    └── run-20260413-修复B/
        └── ...
```

### 步骤生命周期

每个步骤遵循固定流程：

```
START → EXECUTE → COMPLETE → GATE → [LOOP] → NEXT
```

1. **START** -- `advance.mjs start` 标记步骤开始
2. **EXECUTE** -- 读取指令文件，执行任务，写入产物
3. **COMPLETE** -- `advance.mjs complete` 标记步骤完成
4. **GATE** -- 自动质量审查（LLM 审查/命令验证/人工确认）
5. **LOOP** -- 如果 Gate 未通过且有重试配额，自动重试
6. **NEXT** -- Gate 通过后进入下一步

### 门控（Gate）

每步完成后自动触发质量检查：

| 类型 | 执行者 | 适用场景 |
|------|--------|---------|
| `review` | LLM 自动审查产物 | 代码审查、文档检查 |
| `command` | 脚本自动执行 | 语法检查、测试运行 |
| `tool` | MCP 工具 | 外部验证 |
| `manual` | 用户确认 | 关键决策点 |

### Provider

步骤可以由不同执行者完成：

| Provider | 执行方式 |
|----------|---------|
| `null` | 编排器直接执行 |
| `skill:{name}` | 调用已安装的 Skill |
| `agent:{name}` | 调用 Agent（读取 SOUL.md 定义） |
| `command:{cmd}` | 执行 shell 命令 |

### 中断恢复

任何时候中断后，只需：

```
/workflow 继续
```

编排器会自动恢复到中断点继续执行。

---

## 进阶功能

### 依赖 DAG 与并行执行

步骤可以声明依赖关系，无依赖的步骤自动并行：

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

Step 2 和 3 可以并行执行，Step 4 等待两者都完成。

### 自动演化

工作流完成后自动：
1. 从产物和 Gate 结果中提取经验
2. 注入到步骤指令文件的 `<!-- evolve:start -->` 区块
3. 下次运行同一工作流时，指令文件已包含历史经验

### 多级记忆系统

解决长工作流中的上下文窗口限制：

| 级别 | 内容 | 用途 |
|------|------|------|
| Level 1 | 当前步骤完整内容 | 执行当前任务 |
| Level 2 | 最近 3 步摘要 + 当前步骤 | 了解近期进展 |
| Level 3 | 所有步骤详细内容 | 深度调试、回溯 |

**双层记忆架构**：

每个工作流实例支持三层独立记忆存储：

- **MEMORY.md** (2200字符) - 工作流事实和知识
- **USER.md** (1375字符) - 用户偏好设置
- **WORKFLOW.md** (2000字符) - 跨步骤持久化笔记

```bash
# 添加工作流事实
node engine/context-manager.mjs memory --dir ".workflows/my-feature" \
  --action add --content "API 使用 JWT RS256 签名" --target memory

# 添加用户偏好
node engine/context-manager.mjs memory --dir ".workflows/my-feature" \
  --action add --content "项目使用 Go 1.22" --target user
```

**安全特性**：
- 自动 XSS/SQL注入/命令注入检测
- 危险 Unicode 字符过滤
- 字符限制强制执行

**插件化架构**：

支持自定义记忆提供者（数据库、对象存储、加密存储等）：

```javascript
import { MemoryProvider, MemoryManager } from './engine';

class CustomProvider extends MemoryProvider {
  async read(target) { /* ... */ }
  async write(target, entries) { /* ... */ }
}

const manager = new MemoryManager({ workflowDir: '.workflows/my-feature' });
manager.registerProvider('custom', new CustomProvider());
manager.switchProvider('custom');
```

---

## Engine 脚本速查

| 脚本 | 常用命令 | 用途 |
|------|---------|------|
| `session.mjs` | `init`, `run`, `list`, `list-runs` | 工作流和运行实例管理 |
| `advance.mjs` | `start`, `complete`, `status`, `next`, `ready` | 步骤推进 |
| `gate.mjs` | `run`, `result` | 门控评估 |
| `loop.mjs` | `check`, `iterate`, `reset`, `backoff` | 循环重试 |
| `hooks.mjs` | `emit`, `list`, `add` | 生命周期钩子 |
| `coordinator.mjs` | `generate`, `plan`, `validate` | 从目标生成工作流 |
| `evolve.mjs` | `extract`, `inject`, `archive`, `status` | 自动演化 |
| `context-manager.mjs` | `compact`, `summary`, `load-level`, `restore` | 上下文压缩 |
| `memory-agent.mjs` | `summarize`, `index`, `cleanup`, `status` | 记忆管理 |

所有支持运行实例的命令都接受 `--run <id>` 参数。不指定时：单运行自动选择，多运行提示选择。

---

## 架构

```
engine/
├── session.mjs          # 工作流/运行实例管理
├── advance.mjs          # 步骤推进（DAG 感知）
├── gate.mjs             # 门控评估
├── loop.mjs             # 循环重试（指数退避）
├── hooks.mjs            # 生命周期钩子
├── coordinator.mjs      # 从目标生成工作流
├── evolve.mjs           # 自动演化
├── context-manager.mjs  # 多级记忆/上下文压缩
├── memory-agent.mjs     # 记忆代理
├── memory-provider.mjs  # 记忆提供者抽象基类
├── builtin-memory-provider.mjs  # 内置记忆提供者（文件系统）
├── memory-manager.mjs   # 多 Provider 记忆管理
└── utils.mjs            # 工具函数
```

**记忆系统架构**：

```
MemoryProvider (ABC)
  └── BuiltinMemoryProvider (文件系统)
      ├── MEMORY.md (2200 chars)
      ├── USER.md (1375 chars)
      └── WORKFLOW.md (2000 chars)

MemoryManager
  ├── 注册多个 Provider
  ├── 动态切换 Provider
  ├── 统一接口委托
  └── 导出/导入功能
```

---

## 向自治演化

### Phase 1: 辅助决策（当前）

- 每步后 AskQuestion 确认
- Gate 问题人工决策

### Phase 2: 自动推进

```json
{ "runtime": { "auto_confirm": true } }
```

- 无 critical 自动推进
- 反复出现的问题才 ESCALATE

### Phase 3: 自我改进

通过 `evolve.mjs` 自动提取经验，注入到 step 指令文件，让未来迭代受益。

---

## 与 Harness / Superpowers 对比

| 特性 | Harness | Superpowers | Workflow |
|------|---------|-------------|-----------------|
| Evaluator 独立 | Y | Y | Y |
| 步骤编排 | - | Y | Y |
| 状态持久化 | - | - | Y |
| 运行实例隔离 | - | - | Y |
| 自动演化 | - | - | Y |
| 可恢复 | - | - | Y |
| 扩展系统 | - | 有限 | 无限（Hooks）|
| 向自治演化 | 理论 | - | 明确路径 |

---

## 文档

| 文档 | 内容 |
|------|------|
| [SKILL.md](SKILL.md) | 编排器完整指令（Skill 定义） |
| [engine/](engine/) | Engine 模块源码 |

---

## License

MIT
