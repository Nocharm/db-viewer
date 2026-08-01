# Docker Rules

- Use **BuildKit** (`# syntax=docker/dockerfile:1`).
- Use `--mount=type=cache` for apt and uv/pip caches (`rm -rf /var/lib/apt/lists/*` unnecessary).
- Run containers as a **non-root user**.
- Environment config in Dockerfile is a fallback — `.env` via docker-compose is the source of truth.
- Keep images minimal: install only production dependencies.
