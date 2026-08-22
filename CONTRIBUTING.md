# Contributing

Focused fixes, tests, documentation improvements, and security hardening are
welcome.

## Development

Requirements: Node.js 20 or newer and npm.

```bash
npm ci
npm test
npm run lint
```

Tests must not contact real PushPlus, Telegram, or Cloudflare accounts. Use
fixtures and mocked `fetch` implementations.

## Project invariants

- webhook, callback, relay, and inbox routes require the documented tokens;
- deduplication remains stable without storing raw SMS identifiers as keys;
- SMS bodies are stored only for explicit inbox rules and expire automatically;
- filters and intercept rules run before Telegram delivery;
- cleanup stays disabled by default and keeps bounded scans and deletes;
- public examples contain no account-specific origins, namespace IDs, tokens,
  chat IDs, or SMS content.

## Pull requests

- Work from the latest `main` on a separate branch.
- Keep one pull request focused on one problem.
- Add tests for message parsing, rules, routes, and state behavior.
- Run the full test and lint commands.
- Update both READMEs and the relevant guide when behavior or configuration
  changes.
- Explain any Cloudflare permission, retention, or irreversible-delete impact.

Use [SECURITY.md](SECURITY.md) for vulnerabilities and follow the
[Code of Conduct](CODE_OF_CONDUCT.md). Contributions use the repository's
[MIT License](LICENSE).
