# Security

- NEVER commit secrets, API keys, credentials, or `.env` files.
- NEVER hardcode sensitive values — use environment variables.
- Validate all user input at API boundaries.
- Use parameterized queries — never string interpolation for SQL/NoSQL.
- Sanitize output to prevent XSS in frontend code.
- Review auth flows manually — do not delegate security decisions blindly.
