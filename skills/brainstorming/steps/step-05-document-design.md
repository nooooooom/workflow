---
step: 5
title: Document Design
---

# Step 5: Document Design

**Goal:** Write the validated design to a markdown file and commit it.

## Execution Sequence

1. **Create Document Path**

   Determine the output file:
   ```
   docs/designs/{YYYY-MM-DD}-{topic}-design.md
   ```

   Example: `docs/designs/2026-03-31-user-authentication-design.md`

2. **Write Design Document**

   Use the approved design to create the document:

   ```markdown
   # [Feature Name] Design

   **Date:** {YYYY-MM-DD}
   **Status:** Approved
   **Author:** [User Name]

   ## Overview

   [Problem statement and solution summary]

   ## Architecture

   [System architecture if applicable]

   ## Components

   [Component descriptions]

   ## Data Model

   [Data structures and relationships if applicable]

   ## User Experience

   [User journey and interactions if applicable]

   ## Error Handling

   [Failure scenarios and recovery strategies]

   ## Testing Strategy

   [Test approach and coverage goals]

   ## Implementation Notes

   [Any additional notes for implementation]
   ```

3. **Self-Review**

   Before showing to user, review the document:

   **Placeholder Scan:**
   - ❌ Any "TBD", "TODO", incomplete sections?
   - ❌ Vague requirements?
   - ✅ Fix all placeholders

   **Internal Consistency:**
   - Do sections contradict each other?
   - Does architecture match feature descriptions?
   - ✅ Fix any contradictions

   **Scope Check:**
   - Is this focused enough for one implementation plan?
   - Should it be decomposed into sub-projects?
   - ✅ Adjust scope if needed

   **Ambiguity Check:**
   - Could any requirement be interpreted two ways?
   - ✅ Make it explicit

   Fix issues inline. No need to re-review.

4. **Commit Design Document**

   ```bash
   git add docs/designs/{filename}.md
   git commit -m "docs: add design for [feature name]"
   ```

5. **User Review Gate**

   Ask user to review the written document:

   > "Design document written and committed to `docs/designs/{filename}.md`. Please review it and let me know if you want to make any changes before we start creating the implementation plan."

   Wait for user response:
   - If changes requested: Make changes and re-run self-review
   - If approved: Proceed to next step

6. **Load Next Step**

   Once user approves the written document:
   Read fully and follow: `./step-06-transition-to-planning.md`

## Document Quality Checklist

Before showing to user, verify:

- ✅ All sections from design presentation are included
- ✅ No placeholders or TODOs
- ✅ Consistent terminology throughout
- ✅ Clear, specific language (not vague)
- ✅ Proper markdown formatting
- ✅ File committed to git

## Output

Design document created at: `docs/designs/{YYYY-MM-DD}-{topic}-design.md`

## Example File Structure

```
docs/
└── designs/
    ├── 2026-03-31-user-authentication-design.md
    ├── 2026-03-30-api-rate-limiting-design.md
    └── ...
```
