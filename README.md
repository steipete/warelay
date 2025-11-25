# 📡 warelay — WhatsApp Relay CLI

Small CLI to send, receive, auto-reply, and inspect WhatsApp messages over **Twilio** or your personal **WhatsApp Web** session. Ships with a one-command webhook setup (Tailscale Funnel + Twilio callback) and a configurable auto-reply engine (plain text or command/Claude driven).

## Quick Start (5 steps)
1) Prereqs: Node 22+, `pnpm`, a Twilio account with a WhatsApp-enabled number; Tailscale optional for webhooks.
2) Install deps: `pnpm install`
3) Copy `.env.example` → `.env`; set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` **or** `TWILIO_API_KEY`/`TWILIO_API_SECRET`, and `TWILIO_WHATSAPP_FROM=whatsapp:+15551234567` (plus optional `TWILIO_SENDER_SID`).
4) Send a test: `pnpm warelay send --to +12345550000 --message "Hi from warelay"`
5) Choose how to receive replies:
   - Polling (no ingress): `pnpm warelay relay --provider twilio --interval 5 --lookback 10`
   - Webhook (automatic): `pnpm warelay up --port 42873 --path /webhook/whatsapp --verbose`
   - Personal WhatsApp (no Twilio): `pnpm warelay web:login` then `pnpm warelay send --provider web ...`

## Main Features
- **Two providers:** Twilio (default) for reliable delivery + status; Web provider for quick personal sends/receives via QR login.
- **Auto-replies:** Static templates or external commands (Claude-aware), with per-sender or global sessions and `/new` resets.
- **Webhook in one go:** `warelay up` enables Tailscale Funnel, runs the webhook server, and updates the Twilio sender callback URL.
- **Polling fallback:** `relay` polls Twilio when webhooks aren’t available; works headless.
- **Status + delivery tracking:** `status` shows recent inbound/outbound; `send` can wait for final Twilio status.

## Command Cheat Sheet
| Command | What it does | Core flags |
| --- | --- | --- |
| `warelay send` | Send a WhatsApp message (Twilio or Web) | `--to <e164>` `--message <text>` `--wait <sec>` `--poll <sec>` `--provider twilio|web` `--json` `--dry-run` |
| `warelay relay` | Auto-reply loop (poll Twilio or listen on Web) | `--provider auto|twilio|web` `--interval <sec>` `--lookback <min>` `--verbose` |
| `warelay status` | Show recent sent/received messages | `--limit <n>` `--lookback <min>` `--json` |
| `warelay webhook` | Run local inbound webhook server | `--port <port>` `--path <path>` `--reply <text>` `--verbose` `--yes` `--dry-run` |
| `warelay up` | Turn on webhook + Tailscale Funnel + Twilio callback | `--port <port>` `--path <path>` `--verbose` `--yes` `--dry-run` |
| `warelay web:login` (`login`) | Link personal WhatsApp Web via QR | `--verbose` |

## Providers
- **Twilio (default):** needs `.env` creds + WhatsApp-enabled number; supports delivery tracking, polling, webhooks, and auto-reply typing indicators.
- **Web (`--provider web`):** uses your personal WhatsApp via Baileys; supports send/receive + auto-reply, but no delivery-status wait; cache lives in `~/.warelay/credentials/` (rerun `web:login` if logged out).
- **Auto-select (`relay` only):** `--provider auto` uses Web when logged in, otherwise Twilio polling.

## Configuration

### Environment (.env)
| Variable | Required | Description |
| --- | --- | --- |
| `TWILIO_ACCOUNT_SID` | Yes (Twilio provider) | Twilio Account SID |
| `TWILIO_AUTH_TOKEN` | Yes* | Auth token (or use API key/secret) |
| `TWILIO_API_KEY` | Yes* | API key if not using auth token |
| `TWILIO_API_SECRET` | Yes* | API secret paired with `TWILIO_API_KEY` |
| `TWILIO_WHATSAPP_FROM` | Yes (Twilio provider) | WhatsApp-enabled sender, e.g. `whatsapp:+15551234567` |
| `TWILIO_SENDER_SID` | Optional | Overrides auto-discovery of the sender SID |

(*Provide either auth token OR api key/secret.)

### Auto-reply config (`~/.warelay/warelay.json`, JSON5)
- Controls who is allowed to trigger replies (`allowFrom`), reply mode (`text` or `command`), templates, and session behavior.
- Example (Claude command):

```json5
{
  inbound: {
    allowFrom: ["+12345550000"],
    reply: {
      mode: "command",
      bodyPrefix: "You are a concise WhatsApp assistant.\n\n",
      command: ["claude", "--dangerously-skip-permissions", "{{BodyStripped}}"],
      claudeOutputFormat: "text",
      session: { scope: "per-sender", resetTriggers: ["/new"], idleMinutes: 60 }
    }
  }
}
```

### Claude CLI setup (how we run it)
1) Install the official Claude CLI (e.g., `brew install anthropic-ai/cli/claude` or follow the Anthropic docs) and run `claude login` so it can read your API key.
2) In `warelay.json`, set `reply.mode` to `"command"` and point `command[0]` to `"claude"`; set `claudeOutputFormat` to `"text"` (or `"json"/`"stream-json"` if you want warelay to parse and trim the JSON output).
3) (Optional) Add `bodyPrefix` to inject a system prompt and `session` settings to keep multi-turn context (`/new` resets by default).
4) Run `pnpm warelay relay --provider auto` (or `--provider web|twilio`) and send a WhatsApp message; warelay will queue the Claude call, stream typing indicators (Twilio provider), parse the result, and send back the text.

### Auto-reply parameter table
| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `inbound.allowFrom` | `string[]` | empty | E.164 numbers allowed to trigger auto-reply (no `whatsapp:`). |
| `inbound.reply.mode` | `"text" | "command"` | — | Reply style. |
| `inbound.reply.text` | `string` | — | Used when `mode=text`; templating supported. |
| `inbound.reply.command` | `string[]` | — | argv for `mode=command`; each element templated. Stdout (trimmed) is sent. |
| `inbound.reply.template` | `string` | — | Injected as argv[1] (prompt prefix) before the body. |
| `inbound.reply.bodyPrefix` | `string` | — | Prepended to `Body` before templating (great for system prompts). |
| `inbound.reply.timeoutSeconds` | `number` | `600` | Command timeout. |
| `inbound.reply.claudeOutputFormat` | `"text"|"json"|"stream-json"` | — | When command starts with `claude`, auto-adds `--output-format` + `-p/--print` and trims reply text. |
| `inbound.reply.session.scope` | `"per-sender"|"global"` | `per-sender` | Session bucket for conversation memory. |
| `inbound.reply.session.resetTriggers` | `string[]` | `["/new"]` | Exact match or prefix (`/new hi`) resets session. |
| `inbound.reply.session.idleMinutes` | `number` | `60` | Session expires after idle period. |
| `inbound.reply.session.store` | `string` | `~/.warelay/sessions.json` | Custom session store path. |
| `inbound.reply.session.sessionArgNew` | `string[]` | `["--session-id","{{SessionId}}"]` | Args injected for a new session run. |
| `inbound.reply.session.sessionArgResume` | `string[]` | `["--resume","{{SessionId}}"]` | Args for resumed sessions. |
| `inbound.reply.session.sessionArgBeforeBody` | `boolean` | `true` | Place session args before final body arg. |

Templating tokens: `{{Body}}`, `{{BodyStripped}}`, `{{From}}`, `{{To}}`, `{{MessageSid}}`, plus `{{SessionId}}` and `{{IsNewSession}}` when sessions are enabled.

## Webhook & Tailscale Flow
- `warelay webhook` starts the local Express server on your chosen port/path; add `--reply "Got it"` for a static reply when no config file is present.
- `warelay up` adds Funnel: checks `tailscale`, enables `tailscale funnel <port>`, prints the public URL (`https://<tailnet-host><path>`), starts the webhook, discovers the WhatsApp sender SID, and updates Twilio callbacks to the Funnel URL.
- If Funnel is not allowed on your tailnet, the CLI exits with guidance; you can still use `relay --provider twilio` to poll without webhooks.

## Troubleshooting Tips
- Send/receive issues: run `pnpm warelay status --limit 20 --lookback 240 --json` to inspect recent traffic.
- Auto-reply not firing: ensure sender is in `allowFrom` (or unset), and confirm `.env` + `warelay.json` are loaded (reload shell after edits).
- Web provider dropped: rerun `pnpm warelay web:login`; credentials live in `~/.warelay/credentials/`.
- Tailscale Funnel errors: update tailscale/tailscaled; check admin console that Funnel is enabled for this device.

## FAQ & Safety (quick answers)
- Twilio errors: **63016 “permission to send an SMS has not been enabled”** → ensure your number is WhatsApp-enabled; **63007 template not approved** → send a free-form session message within 24h or use an approved template; **63112 policy violation** → adjust content, shorten to <1600 chars, avoid links that trigger spam filters. Re-run `pnpm warelay status` to see the exact Twilio response body.
- Does this store my messages? Warelay only writes `~/.warelay/warelay.json` (config), `~/.warelay/credentials/` (WhatsApp Web auth), and `~/.warelay/sessions.json` (session IDs + timestamps). It does **not** persist message bodies beyond the session store. Logs print to stdout/stderr; redirect or rotate if needed.
- Personal WhatsApp safety: Automation on personal accounts can be rate-limited or logged out by WhatsApp. Use `--provider web` sparingly, keep messages human-like, and re-run `web:login` if the session is dropped.
- Limits to remember: WhatsApp text limit ~1600 chars; avoid rapid bursts—space sends by a few seconds; keep webhook replies under a couple seconds for good UX; command auto-replies time out after 600s by default.
- Deploy / keep running: Use `tmux` or `screen` for ad-hoc (`tmux new -s warelay -- pnpm warelay relay --provider twilio`). For long-running hosts, wrap `pnpm warelay relay ...` or `pnpm warelay up ...` in a systemd service or macOS LaunchAgent; ensure environment variables are loaded in that context.
- Rotating credentials: Update `.env` (Twilio keys), rerun your process; for Web provider, delete `~/.warelay/credentials/` and rerun `pnpm warelay web:login` to relink.
