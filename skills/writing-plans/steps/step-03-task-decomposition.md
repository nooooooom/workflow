---
step: 3
title: Task Decomposition
---

# Step 3: Task Decomposition

**Goal:** Break down the implementation into bite-sized, sequential tasks following TDD principles.

## Execution Sequence

1. **Understand Task Granularity**

   Each step is ONE action (2-5 minutes):

   **Examples of Single Steps:**
   - Write the failing test
   - Run test to verify it fails
   - Implement minimal code
   - Run tests to verify they pass
   - Commit with message

   **NOT Single Steps:**
   - Implement the feature (too broad)
   - Add tests and implementation (multiple actions)
   - Complete the component (multiple tasks)

2. **Apply TDD Cycle**

   For each component/feature:

   ```
   Task N: [Component Name]

   Step 1: Write failing test
   Step 2: Run test (verify failure)
   Step 3: Implement minimal code
   Step 4: Run test (verify pass)
   Step 5: Commit
   ```

3. **Create Task Structure**

   Use this template for each task:

   ````markdown
   ### Task N: [Component Name]

   **Files:**
   - Create: `exact/path/to/file.py`
   - Modify: `exact/path/to/existing.py:123-145`
   - Test: `tests/exact/path/to/test.py`

   - [ ] **Step 1: Write the failing test**

   ```python
   def test_specific_behavior():
       # Arrange
       input_data = "test input"

       # Act
       result = function(input_data)

       # Assert
       assert result == expected
   ```

   - [ ] **Step 2: Run test to verify it fails**

   Run: `pytest tests/path/test.py::test_name -v`
   Expected: FAIL with "function not defined"

   - [ ] **Step 3: Write minimal implementation**

   ```python
   def function(input_data):
       # Minimal implementation to pass test
       return expected
   ```

   - [ ] **Step 4: Run test to verify it passes**

   Run: `pytest tests/path/test.py::test_name -v`
   Expected: PASS

   - [ ] **Step 5: Commit**

   ```bash
   git add tests/path/test.py src/path/file.py
   git commit -m "feat: add specific feature"
   ```
   ````

4. **Order Tasks Logically**

   **Dependency Order:**
   - Foundation first (data models, utilities)
   - Core logic second (business rules)
   - Integration third (APIs, UI)
   - Polish last (error handling, edge cases)

   **Test-First Order:**
   - Test always before implementation
   - Run test before fixing
   - Verify pass before committing

5. **Ensure Completeness**

   Check each task has:
   - ✅ Exact file paths
   - ✅ Complete code (no placeholders)
   - ✅ Exact commands
   - ✅ Expected outputs
   - ✅ Commit messages

6. **No Placeholders Rule**

   Never write these (they are plan failures):
   - "TBD", "TODO", "implement later"
   - "Add appropriate error handling"
   - "Write tests for the above" (without code)
   - "Similar to Task N" (must repeat code)
   - Steps without code blocks (for code tasks)
   - References to undefined types/functions

7. **Write Tasks to Document**

   Append all tasks to the plan document under the Tasks section.

8. **Load Next Step**

   Read fully and follow: `./step-04-plan-finalization.md`

## Task Ordering Strategies

**Bottom-Up (most common):**
1. Data models
2. Business logic
3. API/UI layer
4. Integration tests
5. Documentation

**Top-Down (for exploration):**
1. API/UI tests (acceptance tests)
2. API/UI implementation
3. Business logic
4. Data models

Choose based on design requirements.

## Output

All tasks written to plan document with complete code and commands.

## Example Task

````markdown
### Task 3: User Validation

**Files:**
- Create: `src/models/user.py`
- Test: `tests/models/test_user.py`

- [ ] **Step 1: Write the failing test**

```python
import pytest
from src.models.user import User

def test_user_validation():
    user = User(email="test@example.com", name="Test User")
    assert user.is_valid() == True

    invalid_user = User(email="invalid", name="")
    assert invalid_user.is_valid() == False
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/models/test_user.py::test_user_validation -v`
Expected: FAIL with "ModuleNotFoundError: No module named 'src.models.user'"

- [ ] **Step 3: Write minimal implementation**

```python
# src/models/user.py
class User:
    def __init__(self, email: str, name: str):
        self.email = email
        self.name = name

    def is_valid(self) -> bool:
        return "@" in self.email and len(self.name) > 0
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/models/test_user.py::test_user_validation -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/models/user.py tests/models/test_user.py
git commit -m "feat: add User model with validation"
```
````
