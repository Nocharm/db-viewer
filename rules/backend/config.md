# Config Management

Classify every new config value before placing it:

| Category | Question | Where to put it |
|---|---|---|
| **Environment** | "Will this change per deployment?" | `.env` + Settings + Dockerfile `ENV` + docker-compose `${VAR}` |
| **Tuning** | "Might we tweak this without code changes?" | `.env` + Settings |
| **Business constant** | "Does changing this alter core logic?" | Settings field default only (no `.env`) |

**Rules:**
- `.env` is never committed to git (`.gitignore`).
- Secrets (API keys, passwords) are NEVER hardcoded.
- New Settings fields must have a corresponding `.env` entry with comments (except business constants).
- No duplicate definitions between module-level constants and Settings fields.
