---
step: 4
title: Plan Finalization
---

# Step 4: Plan Finalization

**Goal:** Review the plan for quality and completeness, then save and offer execution options.

## Execution Sequence

1. **Self-Review: Spec Coverage**

   Skim each section/requirement in the design spec:
   - Can you point to a task that implements it?
   - List any gaps found
   - Add missing tasks if needed

2. **Self-Review: Placeholder Scan**

   Search the plan for red flags:
   - "TBD", "TODO", "implement later"
   - "Add appropriate error handling"
   - "Write tests for the above" (without code)
   - "Similar to Task N"
   - Steps without code blocks (for code tasks)

   Fix all issues inline.

3. **Self-Review: Type Consistency**

   Check across all tasks:
   - Function names match between definition and usage
   - Parameter types are consistent
   - Return types are consistent
   - Property names don't change between tasks

   Example bug: `clearLayers()` in Task 3 but `clearFullLayers()` in Task 7

   Fix any inconsistencies.

4. **Finalize Plan Header**

   Ensure the plan starts with:

   ```markdown
   # [Feature Name] Implementation Plan

   > **For agentic workers:** Execute this plan task-by-task using workflow execution with checkpoints.

   **Goal:** [One sentence]

   **Architecture:** [2-3 sentences]

   **Tech Stack:** [Key technologies]

   ---

   ## File Structure

   [Your file map]

   ---

   ## Tasks

   [Your tasks]
   ```

5. **Save Plan Document**

   Write to: `docs/plans/{YYYY-MM-DD}-{feature-name}.md`

6. **Commit Plan**

   ```bash
   git add docs/plans/{filename}.md
   git commit -m "docs: add implementation plan for {feature name}"
   ```

7. **Offer Execution Choice**

   Present options to user:

   > **Plan complete and saved to `docs/plans/{filename}.md`. How would you like to execute this plan?**
   >
   > **1. Workflow Execution (recommended)** - Execute through workflow skill with checkpoints and recovery support
   >
   > **2. Manual Execution** - Execute tasks manually step-by-step in this session
   >
   > **Which approach?**

8. **Handle User Choice**

   **If Workflow Execution chosen:**
   - Inform user: "Loading the workflow skill to execute this plan with checkpoint-based recovery."
   - The workflow skill should be invoked to manage execution
   - The plan becomes the workflow definition

   **If Manual Execution chosen:**
   - Inform user: "Starting manual execution. I'll work through tasks step-by-step."
   - Begin executing tasks sequentially
   - Mark tasks as complete as you progress

## Quality Checklist

Before finalizing, verify:

**Structure:**
- ✅ Header with goal, architecture, tech stack
- ✅ File structure section
- ✅ Tasks section with all tasks

**Tasks:**
- ✅ Each task has files list
- ✅ Each step is a single action (2-5 min)
- ✅ TDD cycle followed (test → run → implement → run → commit)
- ✅ Complete code in every step
- ✅ Exact commands with expected output
- ✅ Commit messages included

**Content:**
- ✅ No placeholders
- ✅ Spec fully covered
- ✅ Types and names consistent
- ✅ Dependencies ordered correctly

**Format:**
- ✅ Proper markdown formatting
- ✅ Code blocks use correct language tags
- ✅ File committed to git

## Output

Plan document created at: `docs/plans/{YYYY-MM-DD}-{feature-name}.md`

## Completion

The writing-plans workflow is complete when:
- ✅ Plan document written
- ✅ Self-review completed
- ✅ Plan committed to git
- ✅ Execution choice offered to user
- ✅ Execution initiated (workflow or manual)

**Next:** Implementation execution begins
