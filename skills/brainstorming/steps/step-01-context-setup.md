---
step: 1
title: Context Setup and Exploration
---

# Step 1: Context Setup and Exploration

**Goal:** Understand the project context, user's idea, and prepare for structured brainstorming.

## Execution Sequence

1. **Project Context Exploration**
   - Check current directory structure and recent file changes
   - Review any existing documentation
   - Check recent git commits for context
   - Identify existing patterns and conventions

2. **Initial Idea Understanding**
   - Listen to the user's initial idea/request
   - Identify if this is:
     - A new feature
     - A component/module
     - A behavior modification
     - A system redesign

3. **Scope Assessment**
   - Does this request describe multiple independent subsystems?
   - If YES (e.g., "build a platform with chat, file storage, billing"):
     - Flag this immediately
     - Suggest decomposition into sub-projects
     - Help user identify: what are the independent pieces, how do they relate, what order should they be built?
     - Brainstorm the first sub-project through the normal design flow
     - Each sub-project gets its own spec → plan → implementation cycle
   - If NO (appropriately-scoped):
     - Proceed to creative exploration

4. **Visual Companion Assessment**
   - Will this project involve visual questions (UI, layout, diagrams)?
   - If YES:
     - Offer visual companion in a SEPARATE message (no other content)
     - Wait for user response
   - If NO:
     - Proceed to step 2

5. **Load Next Step**
   - Once context is understood and scope is appropriate
   - Read fully and follow: `./step-02-creative-exploration.md`

## Output

No document output yet. Context is gathered and scope is validated.

## Anti-Patterns to Avoid

- ❌ Starting implementation before understanding the problem
- ❌ Assuming scope without checking for decomposition needs
- ❌ Combining visual companion offer with other questions
- ❌ Skipping project context exploration
