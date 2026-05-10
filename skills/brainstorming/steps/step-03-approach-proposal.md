---
step: 3
title: Approach Proposal
---

# Step 3: Approach Proposal

**Goal:** Present 2-3 distinct approaches with trade-offs and get user alignment on direction.

## Execution Sequence

1. **Synthesize Insights**

   Review creative exploration outputs:
   - Key ideas generated
   - Constraints identified
   - User preferences from clarifying questions
   - Technical/business requirements

2. **Develop 2-3 Approaches**

   Create distinct approaches (not minor variations):

   **Approach Structure:**
   - **Name**: Memorable label for the approach
   - **Core Concept**: 1-2 sentence description
   - **Key Components**: Main pieces
   - **Trade-offs**:
     - Benefits (what we gain)
     - Costs (what we give up)
     - Risks (what could go wrong)
   - **Best For**: When this approach shines

3. **Present Approaches**

   Format:
   ```markdown
   Based on our exploration, I see three viable approaches:

   ## Recommended: [Approach Name]

   [Core concept and why it's recommended]

   **Benefits:**
   - [Benefit 1]
   - [Benefit 2]

   **Trade-offs:**
   - [Trade-off 1]
   - [Trade-off 2]

   ---

   ## Alternative A: [Approach Name]

   [Description]

   **Best for:** [Use case]

   ---

   ## Alternative B: [Approach Name]

   [Description]

   **Best for:** [Use case]
   ```

4. **Wait for User Selection**

   - User may choose one approach
   - User may ask for modifications
   - User may request hybrid approach

5. **Refine Selected Approach**

   Once user selects:
   - Clarify any remaining questions
   - Ensure alignment on direction
   - Proceed to detailed design

6. **Load Next Step**

   Read fully and follow: `./step-04-design-presentation.md`

## Approach Differentiation

Approaches should differ in **fundamental ways**:
- Architecture (monolith vs microservices)
- Data flow (push vs pull)
- User interaction (CLI vs GUI)
- Technology stack (different frameworks)
- Deployment model (server vs serverless)

NOT just minor implementation details.

## Output

No document output yet. Approach selection is captured for design phase.

## Example

**Approach 1: Event-Driven Architecture**
- Asynchronous, loosely coupled
- Best for: High scalability, complex workflows

**Approach 2: Request-Response API**
- Synchronous, simpler to understand
- Best for: CRUD operations, simple queries

**Approach 3: Hybrid Model**
- Events for writes, API for reads
- Best for: Balanced complexity and scalability
