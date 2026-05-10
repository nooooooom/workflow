---
step: 4
title: Design Presentation
---

# Step 4: Design Presentation

**Goal:** Present the detailed design in sections and get user approval.

## Execution Sequence

1. **Prepare Design Sections**

   Structure the design into logical sections:

   - **Overview** (always include)
     - Problem statement
     - Proposed solution summary
     - Key benefits

   - **Architecture** (for system designs)
     - Component diagram
     - Data flow
     - Integration points

   - **Components** (always include)
     - Key components/modules
     - Responsibilities
     - Interfaces

   - **Data Model** (if applicable)
     - Data structures
     - Relationships
     - Storage considerations

   - **User Experience** (if applicable)
     - User journey
     - Key interactions
     - Edge cases

   - **Error Handling** (always include)
     - Failure scenarios
     - Recovery strategies
     - User feedback

   - **Testing Strategy** (always include)
     - Test levels
     - Key test scenarios
     - Coverage goals

2. **Present Section by Section**

   For each section:

   a. **Write the section**
      - Scale to complexity: 2-3 sentences if straightforward, 200-300 words if nuanced
      - Be specific, not vague
      - Include diagrams or examples if helpful

   b. **Ask for feedback**
      > "Does this [section name] look right so far?"

   c. **Iterate if needed**
      - Clarify confusion
      - Adjust based on feedback
      - Move to next section when approved

3. **Design Principles**

   Apply throughout the design:

   - **Isolation**: Each component has one clear purpose
   - **Clarity**: Interfaces are well-defined
   - **Independence**: Components can be understood and tested separately
   - **Answerability**: For each unit, can you answer:
     - What does it do?
     - How do you use it?
     - What does it depend on?

4. **Existing Codebase Considerations**

   If working in an existing codebase:

   - Follow established patterns
   - Identify improvements for areas you're touching
   - Stay focused on current goal (don't propose unrelated refactoring)
   - Document integration with existing components

5. **Final Approval**

   After all sections are reviewed:

   > "This completes the design. Does the overall design look good to you? Any final adjustments?"

   Wait for user approval before proceeding.

6. **Load Next Step**

   Once user approves the design:
   Read fully and follow: `./step-05-document-design.md`

## Section Depth Guidelines

- **Simple feature**: Each section = 2-3 sentences
- **Moderate feature**: Each section = 1-2 paragraphs
- **Complex system**: Each section = 200-300 words + diagrams

Match detail level to complexity.

## Output

No document output yet. Design is presented interactively for approval.

## Anti-Patterns

- ❌ Presenting entire design at once (overwhelming)
- ❌ Vague descriptions ("we'll handle errors appropriately")
- ❌ Skipping sections (even simple projects need all sections)
- ❌ Too much detail for simple features
- ❌ Too little detail for complex systems
