---
step: 1
title: Scope Validation
---

# Step 1: Scope Validation

**Goal:** Verify the design is appropriately scoped for a single implementation plan.

## Execution Sequence

1. **Load Design Document**

   Read the design document provided as input.

2. **Assess Scope**

   Check if the design describes:

   **Single Feature (Appropriate Scope):**
   - One cohesive functionality
   - Clear boundaries
   - Can produce working, testable software independently

   **Multiple Subsystems (Too Broad):**
   - Multiple independent pieces
   - Example: "platform with chat, file storage, billing, and analytics"
   - Each piece could be its own project

3. **Decision**

   **If appropriately scoped:**
   - Proceed to file structure planning
   - Load next step

   **If too broad:**
   - Stop and inform user:

   > "This design covers multiple independent subsystems. I recommend breaking this into separate plans, one per subsystem, where each plan produces working, testable software on its own.

   > Would you like me to:
   > 1. Help decompose this into sub-projects first?
   > 2. Proceed with a plan for the first subsystem?
   > 3. Create a single large plan (not recommended)?"

   Wait for user direction.

4. **Load Next Step**

   Once scope is validated:
   Read fully and follow: `./step-02-file-structure.md`

## Scope Decision Criteria

**Appropriate for single plan:**
- ✅ Single cohesive feature
- ✅ All parts work together
- ✅ Clear integration points
- ✅ Can be tested as a unit

**Requires decomposition:**
- ❌ Multiple independent features
- ❌ Could be split into separate deployments
- ❌ Each part has its own user journey
- ❌ Different success metrics for each part

## Output

No document output yet. Scope is validated for planning.

## Examples

**Appropriate Scope:**
- User authentication system
- API rate limiting
- Dashboard with specific widgets

**Too Broad:**
- Entire user management platform (auth, profiles, permissions, audit logs)
- E-commerce system (catalog, cart, checkout, payments, inventory)
- Analytics platform (data collection, storage, processing, visualization)
