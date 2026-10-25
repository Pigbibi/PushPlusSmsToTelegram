# Security policy

Security fixes target the latest release and `main` branch.

## Reporting a vulnerability

Report security vulnerabilities through [GitHub private vulnerability reporting](https://github.com/Pigbibi/PushPlusSmsToTelegram/security/advisories/new). Do not post exploit details, credentials, private sessions or personal data in public issues or PRs. Include the affected version, impact and minimal redacted reproduction. The maintainer handles reports on a best-effort basis; no bounty or response-time guarantee is implied.

## Relevant issues

- bypassing webhook, callback, relay, or inbox authentication;
- leaking SMS bodies or one-time codes;
- cross-deployment routing caused by an unsafe relay origin;
- predictable deduplication or inbox keys;
- rule parsing that sends or stores an unintended message;
- unbounded cleanup or irreversible deletion outside configured limits;
- workflow changes that expose repository or Cloudflare secrets.

If a credential or message is exposed, revoke affected credentials and remove
the exposed data immediately. Do not wait for a code release.
