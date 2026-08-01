# Testing Rules

- New features require corresponding test cases.
- **Mock external dependencies** (APIs, databases, third-party engines) to keep tests fast.
- Do NOT mock internal logic — test the real code paths.
- Follow the **AAA pattern**: Arrange, Act, Assert.
- Run single tests during development, full suite before commit.
- Test deps belong in the dev requirements file (see `dependencies.md`).
