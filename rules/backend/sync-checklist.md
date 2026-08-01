# Sync Checklist

Run when sync is explicitly requested — via `/sync` (change-based) or `/sync-all` (full sweep), not automatically on every code change (frequent syncing adds overhead without payoff). When asked, check these files; some may need no change.

| File | When to update |
|------|----------------|
| Dependency files | Adding/removing/updating packages |
| Dockerfile | System packages, build steps, ENV, ports |
| .dockerignore | New folders/files that shouldn't be in build context |
| docker-compose.yml | Ports, volumes, env vars, services |
| .env | New config values added to Settings |
| README.md | Endpoints, env vars, structure, setup instructions |
| Test scenario docs | Test cases added/removed, endpoint behavior changed |

**Sync order:** code → dependencies → Dockerfile → .dockerignore → docker-compose → .env → README → test docs
