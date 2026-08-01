# Error Handling

- Raise errors explicitly — never silently swallow exceptions.
- Use specific error types that clarify what failed.
- Error messages must include context (request params, status codes).
- External APIs: retry with logging, then raise the last error.
- Use structured logging with fields, not string interpolation.
- Trust internal code — validate only at boundaries, don't re-validate internally (input validation rules: `security.md`).
