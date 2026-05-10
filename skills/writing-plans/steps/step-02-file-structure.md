---
step: 2
title: File Structure Planning
---

# Step 2: File Structure Planning

**Goal:** Map out which files will be created or modified and define clear responsibilities.

## Execution Sequence

1. **Analyze Design Document**

   Extract from the design:
   - Components/modules identified
   - Data models
   - User interfaces
   - Integration points
   - Testing requirements

2. **Existing Codebase Analysis**

   If working in existing codebase:

   a. **Explore Current Structure**
      - Check directory layout
      - Identify existing patterns
      - Find similar features for reference
      - Note conventions (naming, organization)

   b. **Identify Modification Points**
      - Files that need changes
      - Integration with existing code
      - Potential conflicts

   c. **Follow Established Patterns**
      - Use existing conventions
      - Maintain consistency
      - Only split large files if they're unwieldy AND you're touching them

3. **Design File Structure**

   Create a file map:

   ```markdown
   ## File Structure

   **New Files:**
   - `src/modules/{feature}/{component}.py` - [responsibility]
   - `tests/{feature}/test_{component}.py` - [test focus]

   **Modified Files:**
   - `src/main.py:45-67` - [what changes]
   - `config/settings.py` - [add configuration]

   **Documentation:**
   - `docs/{feature}/setup.md` - [setup instructions]
   ```

4. **Apply Design Principles**

   For each file, verify:

   **Isolation:**
   - ✅ One clear responsibility per file
   - ✅ Well-defined interfaces
   - ✅ Can be understood independently

   **Clarity:**
   - ✅ Purpose is obvious from path/name
   - ✅ Dependencies are explicit

   **Testability:**
   - ✅ Can be tested in isolation
   - ✅ Clear inputs/outputs

5. **Validate Structure**

   Check:
   - Do files that change together live together?
   - Is responsibility split by domain, not technical layer?
   - Are files small enough to hold in context?
   - Does it follow existing patterns (for existing codebases)?

6. **Document Structure**

   Add the file structure section to the plan:

   ```markdown
   ## File Structure

   [Your file map from step 3]

   ---

   ## Tasks
   ```

7. **Load Next Step**

   Read fully and follow: `./step-03-task-decomposition.md`

## File Naming Conventions

**By Type:**
- Components: `{component-name}.{ext}`
- Tests: `test_{component-name}.{ext}`
- Utilities: `{utility-name}.util.{ext}`
- Types: `{domain}.types.{ext}`

**By Feature:**
- Group by feature when possible
- Keep related files together
- Example: `src/features/{feature-name}/{component}.{ext}`

## Output

File structure section added to plan document.

## Anti-Patterns

- ❌ Large files doing too many things
- ❌ Splitting by technical layer (controllers, services, repositories) instead of by feature
- ❌ Files with unclear or mixed responsibilities
- ❌ Ignoring existing codebase patterns
- ❌ Premature abstraction (creating utilities for one-time use)
