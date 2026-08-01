# Documentation Rules

`README.md` (and `USAGE.md` when needed) describes **the current project**. Don't leave template placeholders or meta guides in place.

**Do:**
- Root `README.md` covers — one-line summary of what the project does, who uses it, setup, key commands, primary directory layout.
- If the project warrants a `USAGE.md` (CLI tool, library, app with separate end-user guide), write **that project's** usage — not a meta guide.
- For projects started from a template, replacing the root `README.md` placeholder is one of the first tasks.
- README upkeep is two-tier — at commit time, update only the sections the commit invalidates (see `git.md` — Before Every Commit); full sweeps run on request via `/sync` · `/sync-all` (backend/Docker projects: `rules/backend/sync-checklist.md`).

**Don't:**
- Stack `feat:` / `fix:` commits while `_TODO_` or `<project name>` placeholders remain.
- Leave the template's meta README/USAGE (which describes the *template*, not your project) in a downstream project.
- Make the first meaningful commit while the README is still a one-line placeholder.
