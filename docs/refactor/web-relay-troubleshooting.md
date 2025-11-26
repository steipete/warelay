# Web Relay Troubleshooting (Nov 26, 2025)

## Symptoms & quick fixes
- **Stream Errored / Conflict / status 409–515:** WhatsApp closed the socket because another session is active or creds went stale. Run `warelay logout` then `warelay login --provider web` and restart the relay.
- **Logged out:** Console prints “session logged out”; re-link with `warelay login --provider web`.
- **Repeated retries then exit:** Reconnects are capped (default 12 attempts). Tune with `--web-retries`, `--web-retry-initial`, `--web-retry-max`, or config `web.reconnect`.
- **No inbound messages:** Ensure the QR-linked account is online in WhatsApp, and check logs for `web-heartbeat` to confirm auth age/connection.

## Helpful commands
- Start relay web-only: `pnpm warelay relay --provider web --verbose`
- Show who is linked: `pnpm warelay relay --provider web --verbose` (first line prints the linked E.164)
- Logout (clear creds): `pnpm warelay logout`
- Relink: `pnpm warelay login --provider web`
- Tail logs (default): `tail -f /tmp/warelay/warelay.log`

## Reading the logs
- `web-reconnect`: close reasons, retry/backoff, max-attempt exit.
- `web-heartbeat`: connectionId, messagesHandled, authAgeMs, uptimeMs (every 60s by default).
- `web-auto-reply`: inbound/outbound message records with correlation IDs.

## When to tweak knobs
- High churn networks: increase `web.reconnect.maxAttempts` or `--web-retries`.
- Slow links: raise `--web-retry-max` to give more headroom before bailing.
- Chatty monitors: increase `--web-heartbeat` interval if log volume is high.

## If it keeps failing
1) `warelay logout` → `warelay login --provider web` (fresh QR link).
2) Ensure no other device/browser is using the same WA Web session.
3) Check WhatsApp mobile app is online and not in low-power mode.
4) If status is 515, let the client restart once after pairing (already handled automatically).
5) Capture the last `web-reconnect` entry and the status code before escalating.
