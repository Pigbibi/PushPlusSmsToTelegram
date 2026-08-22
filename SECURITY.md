# Security policy

Security fixes target the latest release and `main` branch.

## Reporting

Do not open a public issue containing PushPlus credentials, Telegram bot tokens,
chat IDs, Cloudflare tokens, callback or inbox tokens, private Worker origins,
SMS content, or exploit details. Use GitHub's
[private vulnerability reporting](https://github.com/Pigbibi/PushPlusSmsToTelegram/security/advisories/new).
If that form is unavailable, ask for a private contact through information on
the repository owner's GitHub profile without sharing technical details
publicly.

Include the affected commit, route, attacker access, reproduction steps, data
exposed, and suggested mitigation in the private report.

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
