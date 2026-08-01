# Comment Rules

Write **concise comments that reveal intent**.

**Do:**
- **Why**, not What — explain why the code exists in one line.
- **Module docstring** — every file gets a one-line summary at the top (`"""Role description."""`).
- **Function/class** — one or two lines on role and caveats. Skip if obvious.
- **Non-obvious logic** (library options, formulas, race conditions) — inline reason on the line or above.
- **Constants** — document unit, range, and impact of changes inline.

**Don't:**
- `# read the file`, `# return result` — comments that restate the code.
- Docstrings that duplicate the function name.
- Verbose separator blocks (`# ---...---`) except for section dividers.
