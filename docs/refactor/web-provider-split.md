# Web Provider Refactor (Nov 26, 2025)

Context: `src/provider-web.ts` was a 900+ line ball of mud mixing session management, outbound sends, inbound handling, auto-replies, and media helpers. We split it into focused modules under `src/web/` and adjusted tests/CLI behavior.

## What changed
- New modules: `session.ts`, `login.ts`, `outbound.ts`, `inbound.ts`, `auto-reply.ts`, `media.ts`; barrel remains `src/provider-web.ts`.
- CLI adds `warelay logout` to clear `~/.warelay/credentials`; tested in `src/web/logout.test.ts`.
- Relay now **exits instead of falling back to Twilio** when the web provider fails (even in `--provider auto`), so outages are visible.
- Tests split accordingly; all suites green.
- Structured logging + heartbeats: web relay now emits structured logs with `runId`/`connectionId` plus periodic heartbeats (default every 60s) that include auth age and message counts.
- Bounded reconnects: web relay uses capped exponential backoff (default 2s→30s, max 12 attempts). CLI knobs `--web-retries`, `--web-retry-initial`, `--web-retry-max`, `--web-heartbeat` and config `web.reconnect`/`web.heartbeatSeconds` tune the behavior.
- Backoff reset after healthy uptime; logged-out state still exits immediately.
- Extracted reconnect/heartbeat helpers to `src/web/reconnect.ts` with unit tests.
- Added troubleshooting guide at `docs/refactor/web-relay-troubleshooting.md` (common errors, knobs, logs).

## How to use
- Link: `warelay login --provider web`
- Logout: `warelay logout` (deletes `~/.warelay/credentials`)
- Run relay web-only: `warelay relay --provider web --verbose`

## Follow-ups worth doing
- Document the new module boundaries in README/docs; add a one-liner explaining the no-fallback behavior.
- Add bounded backoff/jitter in `monitorWebProvider` reconnect loop with clearer exit codes. ✅
- Tighten config validation (`mediaMaxMb`, etc.) on load. ✅ (schema now includes `web.*` knobs)
- Emit structured logs for reconnect/close reasons to help ops triage (status, isLoggedOut). ✅
- Add quick troubleshooting snippets (how to read logs, restart relay, rotate creds).
