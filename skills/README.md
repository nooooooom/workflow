# Skills Implementation Summary

This directory contains two comprehensive skills that work together to transform ideas into executable implementation plans.

## Skills

### 1. Brainstorming (`skills/brainstorming/`)

**Purpose:** Transform initial ideas into fully-formed designs through structured creative exploration and collaborative dialogue.

**Key Features:**
- Structured design process with step-file architecture
- Multiple creative brainstorming techniques (SCAMPER, Six Thinking Hats, First Principles, etc.)
- Visual companion support for UI/layout discussions
- Anti-bias protocols to maintain true divergence
- Incremental validation with user approval at each stage
- Automatic transition to planning workflow

**Workflow Steps:**
1. Context Setup & Exploration
2. Creative Exploration (with multiple techniques)
3. Approach Proposal (2-3 alternatives)
4. Design Presentation (section-by-section)
5. Document Design (with self-review)
6. Transition to Planning

**Output:** Design document at `docs/designs/{date}-{topic}-design.md`

### 2. Writing Plans (`skills/writing-plans/`)

**Purpose:** Transform approved designs into detailed, executable implementation plans with bite-sized tasks.

**Key Features:**
- TDD (Test-Driven Development) methodology
- Bite-sized tasks (2-5 minutes each)
- Complete code in every step (no placeholders)
- File structure planning with clear responsibilities
- Automatic quality checks (spec coverage, placeholder scan, type consistency)
- Multiple execution modes (workflow or manual)

**Workflow Steps:**
1. Scope Validation
2. File Structure Planning
3. Task Decomposition (TDD cycle)
4. Plan Finalization (with self-review)

**Output:** Implementation plan at `docs/plans/{date}-{feature-name}.md`

## Integration

The two skills are designed to work in sequence:

```
Idea → Brainstorming Skill → Design Doc → Writing Plans Skill → Implementation Plan
```

The brainstorming skill automatically invokes the writing-plans skill when the design is approved, ensuring a smooth transition from ideation to planning.

## Architecture

Both skills use **step-file architecture**:

- **Self-contained steps:** Each step is a separate file with embedded rules
- **Sequential execution:** Steps must be completed in order
- **State tracking:** Progress tracked in document frontmatter
- **Quality gates:** Built-in reviews and validations

## Usage

To use these skills, invoke them with the Skill tool:

```
# For brainstorming
Skill(skill="brainstorming")

# For writing plans (usually called automatically by brainstorming)
Skill(skill="writing-plans")
```

## Best Practices

**For Brainstorming:**
- Keep user in generative mode as long as possible
- Generate quantity before quality (30-50 ideas minimum)
- Shift creative domains to avoid clustering
- Present visual companion separately from questions
- Always get explicit design approval before documenting

**For Writing Plans:**
- Each step = one 2-5 minute action
- Show complete code, never placeholders
- Follow TDD: test → run → implement → run → commit
- Order tasks by dependency
- Include exact commands and expected outputs

## File Structure

```
skills/
├── brainstorming/
│   ├── SKILL.md                          # Main skill definition
│   ├── workflow.md                       # Workflow orchestration
│   └── steps/
│       ├── step-01-context-setup.md
│       ├── step-02-creative-exploration.md
│       ├── step-03-approach-proposal.md
│       ├── step-04-design-presentation.md
│       ├── step-05-document-design.md
│       └── step-06-transition-to-planning.md
└── writing-plans/
    ├── SKILL.md                          # Main skill definition
    ├── workflow.md                       # Workflow orchestration
    └── steps/
        ├── step-01-scope-validation.md
        ├── step-02-file-structure.md
        ├── step-03-task-decomposition.md
        └── step-04-plan-finalization.md
```

## Design Principles

**Isolation & Clarity:**
- Each file has one clear responsibility
- Well-defined interfaces between components
- Can be understood and tested independently

**Quality Assurance:**
- Built-in self-review processes
- Placeholder detection
- Consistency checking
- Spec coverage validation

**User-Centric:**
- Incremental validation at each stage
- Explicit approval gates
- Clear communication of progress
- Flexible execution options

## Skill 可用性：本地 vs 外部

工作流模板引用的 Skill 分为两类：

### 本地 Skill（`skills/` 目录）

| Skill | 路径 | 说明 |
|-------|------|------|
| `brainstorming` | `skills/brainstorming/` | 创意探索与设计 |
| `writing-plans` | `skills/writing-plans/` | 实施计划编写 |

### 外部 Skill（superpowers 系列）

以下 Skill 由 Claude Code superpowers 提供，需通过 Claude Code 安装。工作流步骤可通过 `skill:{name}` provider 引用：

| Skill | Provider 格式 | 用途 |
|-------|--------------|------|
| systematic-debugging | `skill:systematic-debugging` | Bug 修复流程 |
| test-driven-development | `skill:test-driven-development` | TDD 开发流程 |
| brainstorming | `skill:brainstorming` | 创意探索与设计 |
| writing-plans | `skill:writing-plans` | 实施计划编写 |

> **注意**：外部 Skill 的安装状态取决于用户的 Claude Code 环境。若步骤引用的 Skill 未安装，Provider 解析阶段会报错。

---

## Integration with Workflow System

These skills are designed to integrate with a broader workflow execution system:

1. **Brainstorming** creates the design document
2. **Writing Plans** creates the implementation plan
3. **Workflow Execution** (separate skill) executes the plan with checkpoint-based recovery

The workflow execution skill can load implementation plans as workflow definitions, providing:
- Checkpoint-based progress tracking
- Recovery from failures
- State persistence
- Parallel task execution where appropriate
