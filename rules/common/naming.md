# Naming — Function Verbs

언어 공통 네이밍 규칙. 언어별 casing 컨벤션은 `languages/<lang>.md` 에 있다.

**Function names must start with a verb.** The verb clarifies intent — the reader knows whether the function reads, mutates, creates, or decides. Apply your language's casing.

| Purpose | Verbs |
|---------|-------|
| Read / retrieve | `get`, `fetch`, `load`, `read`, `find` |
| Create | `create`, `build`, `make`, `generate` |
| Update / mutate | `update`, `set`, `apply`, `merge` |
| Delete | `delete`, `remove`, `clear` |
| Transform | `parse`, `format`, `convert`, `normalize` |
| Validate / check | `validate`, `check`, `ensure`, `verify` |
| Decide (bool return) | `is`, `has`, `should`, `can` |
| Handle / process | `handle`, `process`, `run`, `execute` |

Avoid noun-only function names — rename to a verb form (`userData` → `getUserData`, `config` → `loadConfig`).
