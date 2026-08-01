# TypeScript Rules

Rules for TypeScript/JavaScript projects. Imported by the main CLAUDE.md.

---

## Strict Mode

- `tsconfig.json` must have `"strict": true`.
- Never use `// @ts-ignore` or `// @ts-expect-error` without a comment explaining why.
- Fix type errors properly — do not suppress them.

---

## Variables

- `const` by default.
- `let` only when reassignment is necessary.
- `var` is forbidden.
- Destructure objects and arrays when accessing multiple properties.

---

## Modules

- Use ES modules (`import` / `export`), not CommonJS (`require` / `module.exports`).
- Prefer **named exports** over default exports — easier to refactor and search.
- Group imports: external packages → internal modules → relative imports.

---

## Types

- Prefer `interface` over `type` for object shapes — interfaces are extendable and produce clearer errors.
- `any` is forbidden. Use `unknown` when the type is genuinely unknown, then narrow.
- Utility types (`Partial`, `Pick`, `Omit`, `Record`) over manual rewriting.
- Avoid type assertions (`as`) — prefer type guards (`if ('key' in obj)`).

---

## Null Handling

- Use optional chaining (`?.`) for safe property access.
- Use nullish coalescing (`??`) for default values — not `||` (which catches `0`, `""`).
- Prefer early returns over deeply nested null checks.

---

## Naming

| Target | Convention | Example |
|--------|-----------|---------|
| Variables/functions | `camelCase` | `getUserData` |
| Classes/components | `PascalCase` | `UserProfile` |
| Constants | `UPPER_SNAKE_CASE` | `MAX_RETRY_COUNT` |
| Interfaces | `PascalCase` (no `I` prefix) | `UserConfig` |
| Enums | `PascalCase` members | `Status.Active` |
| Boolean | `is` / `has` / `should` prefix | `isValid`, `hasAccess` |
| File names | `kebab-case` or `camelCase` (follow project convention) | `user-profile.ts` |

**Function names must start with a verb** — verb→purpose table is shared in `rules/common/naming.md`. TS casing: `getUser`, `createSession`, `isValid()`.

For React event handlers, `handle` is the caller-side convention and `on` is the prop-side convention: `<Button onClick={handleSubmit} />`.

---

## Code Style

- **2-space** indentation.
- Semicolons: follow project convention (prefer consistent choice).
- Trailing commas in multi-line objects, arrays, and parameters.
- Enforce with `eslint` + `prettier`.
- Max line length: project convention (80–120).

---

## Dependencies

```json
{
  "dependencies": {},        // Production only
  "devDependencies": {}      // Dev/test/build tools
}
```

- Use a lock file (`package-lock.json`, `pnpm-lock.yaml`, `bun.lockb`).
- `node_modules/` in `.gitignore`.
- Prefer `npx` or package.json `scripts` over global installs.

---

## Error Handling

- Use `try/catch` with specific error types where possible.
- Never catch and silently ignore: `catch (e) {}`.
- For async: prefer `try/catch` inside `async` functions over `.catch()` chains.
- API error responses should include status code, message, and context.

---

## React (if applicable)

- Functional components only — no class components.
- Hooks follow the Rules of Hooks (top-level, no conditionals).
- Component files: one exported component per file.
- Props: define with `interface`, not inline.
- Avoid `useEffect` for derived state — compute during render.
