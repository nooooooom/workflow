---
step: 6
title: Transition to Planning
---

# Step 6: Transition to Planning

**Goal:** Hand off to the writing-plans skill to create the implementation plan.

## Execution Sequence

1. **Confirm Completion**

   Verify:
   - ✅ Design document written
   - ✅ Self-review completed
   - ✅ User reviewed and approved
   - ✅ Document committed to git

2. **Transition Announcement**

   Inform the user:

   > "Great! The design is approved. Now I'll use the writing-plans skill to create a detailed implementation plan."

3. **Invoke Writing-Plans Skill**

   Use the Skill tool to invoke writing-plans:

   ```
   Skill(skill="writing-plans")
   ```

4. **Pass Context**

   When the skill loads, provide:
   - Path to the design document: `docs/designs/{filename}.md`
   - Any additional context from brainstorming session
   - User preferences or constraints identified

## Terminal State

**This is the terminal state of brainstorming.**

Do NOT invoke:
- ❌ Any implementation skill
- ❌ Any domain-specific skill (frontend-design, mcp-builder, etc.)
- ❌ Test-driven-development skill

ONLY invoke:
- ✅ writing-plans skill

## What Happens Next

The writing-plans skill will:
1. Read the design document
2. Map out file structure
3. Create bite-sized implementation tasks
4. Offer execution options (subagent-driven or inline)

## Completion

The brainstorming workflow is complete when:
- Design document exists and is approved
- Writing-plans skill has been invoked
- Control has been handed off to the planning workflow

## Summary

**Brainstorming Workflow:**
1. ✅ Explored project context
2. ✅ Applied creative techniques
3. ✅ Asked clarifying questions
4. ✅ Proposed approaches
5. ✅ Presented design sections
6. ✅ Wrote design document
7. ✅ User reviewed and approved
8. ✅ Transitioned to planning

**Next:** Implementation planning with writing-plans skill
