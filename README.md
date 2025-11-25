# 📡 warelay — Send, receive, and auto-reply on WhatsApp.

<p align="center">
  <img src="README-header.png" alt="warelay header" width="640">
</p>

<p align="center">
  <a href="https://github.com/steipete/warelay/actions/workflows/ci.yml?branch=main"><img src="https://img.shields.io/github/actions/workflow/status/steipete/warelay/ci.yml?branch=main&style=for-the-badge" alt="CI status"></a>
  <a href="https://www.npmjs.com/package/warelay"><img src="https://img.shields.io/npm/v/warelay.svg?style=for-the-badge" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
</p>

Send, receive, auto-reply, and inspect WhatsApp messages over **Twilio** or your personal **WhatsApp Web** session. Ships with a one-command webhook setup (Tailscale Funnel + Twilio callback) and a configurable auto-reply engine (plain text or command/Claude driven).

## Quick Start (pick your engine)
Install from npm (global): `npm install -g warelay` (Node 22+). Then choose **one** path:

**A) Personal WhatsApp Web (preferred: no Twilio creds, fastest setup)**
1. Link your account: `warelay login` (scan the QR).
2. Send a message: `warelay send --to +12345550000 --message "Hi from warelay"` (add `--provider web` if you want to force the web session).
3. Stay online & auto-reply: `warelay relay --verbose` (defaults to Web when logged in, falls back to Twilio otherwise).

**B) Twilio WhatsApp number (for delivery status + webhooks)**
1. Copy `.env.example` → `.env`; set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` **or** `TWILIO_API_KEY`/`TWILIO_API_SECRET`, and `TWILIO_WHATSAPP_FROM=whatsapp:+19995550123` (optional `TWILIO_SENDER_SID`).
2. Send a message: `warelay send --to +12345550000 --message "Hi from warelay"`.
3. Receive replies:
   - Polling (no ingress): `warelay relay --provider twilio --interval 5 --lookback 10`
   - Webhook + public URL via Tailscale Funnel: `warelay webhook --ingress tailscale --port 42873 --path /webhook/whatsapp --verbose`

> Already developing locally? You can still run `pnpm install` and `pnpm warelay ...` from the repo, but end users only need the npm package.

## Main Features
- **Two providers:** Twilio (default) for reliable delivery + status; Web provider for quick personal sends/receives via QR login.
- **Auto-replies:** Static templates or external commands (Claude-aware), with per-sender or global sessions and `/new` resets.
- Claude setup guide: see `docs/claude-config.md` for the exact Claude CLI configuration we support.
- **Webhook in one go:** `warelay webhook --ingress tailscale` enables Tailscale Funnel, runs the webhook server, and updates the Twilio sender callback URL.
- **Polling fallback:** `relay` polls Twilio when webhooks aren’t available; works headless.
- **Status + delivery tracking:** `status` shows recent inbound/outbound; `send` can wait for final Twilio status.

## Command Cheat Sheet
| Command | What it does | Core flags |
| --- | --- | --- |
| `warelay send` | Send a WhatsApp message (Twilio or Web) | `--to <e164>` `--message <text>` `--wait <sec>` `--poll <sec>` `--provider twilio\|web` `--json` `--dry-run` `--verbose` |
| `warelay relay` | Auto-reply loop (poll Twilio or listen on Web) | `--provider <auto\|twilio\|web>` `--interval <sec>` `--lookback <min>` `--verbose` |
| `warelay status` | Show recent sent/received messages | `--limit <n>` `--lookback <min>` `--json` `--verbose` |
| `warelay webhook` | Run inbound webhook (`ingress=tailscale` updates Twilio; `none` is local-only) | `--ingress tailscale\|none` `--port <port>` `--path <path>` `--reply <text>` `--verbose` `--yes` `--dry-run` |
| `warelay login` | Link personal WhatsApp Web via QR | `--verbose` |

### Sending images
- Twilio: `warelay send --to +1... --message "Hi" --media ./pic.jpg --serve-media` (needs `warelay webhook --ingress tailscale` or `--serve-media` to auto-host via Funnel; max 5 MB).
- Web: `warelay send --provider web --media ./pic.jpg --message "Hi"` (local path or URL; no hosting needed).
- Auto-replies can attach `mediaUrl` in `~/.warelay/warelay.json` (used alongside `text` when present). Web auto-replies now auto-resize/recompress images and cap size by config: set `inbound.reply.mediaMaxMb` (default 5) to control the post-compression limit; images are resized (max side 2048px) and JPEG-compressed to fit.

## Providers
- **Twilio (default):** needs `.env` creds + WhatsApp-enabled number; supports delivery tracking, polling, webhooks, and auto-reply typing indicators.
- **Web (`--provider web`):** uses your personal WhatsApp via Baileys; supports send/receive + auto-reply, but no delivery-status wait; cache lives in `~/.warelay/credentials/` (rerun `login` if logged out).
- **Auto-select (`relay` only):** `--provider auto` uses Web when logged in, otherwise Twilio polling.

Best practice: use a dedicated WhatsApp account (separate SIM/eSIM or business account) for automation instead of your primary personal account to avoid unexpected logouts or rate limits.

## Configuration

### Environment (.env)
| Variable | Required | Description |
| --- | --- | --- |
| `TWILIO_ACCOUNT_SID` | Yes (Twilio provider) | Twilio Account SID |
| `TWILIO_AUTH_TOKEN` | Yes* | Auth token (or use API key/secret) |
| `TWILIO_API_KEY` | Yes* | API key if not using auth token |
| `TWILIO_API_SECRET` | Yes* | API secret paired with `TWILIO_API_KEY` |
| `TWILIO_WHATSAPP_FROM` | Yes (Twilio provider) | WhatsApp-enabled sender, e.g. `whatsapp:+19995550123` |
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

### Logging (optional)
- File logs are written to `/tmp/warelay/warelay.log` by default. Levels: `silent | fatal | error | warn | info | debug | trace` (CLI `--verbose` forces `debug`). Web-provider inbound/outbound entries include message bodies and auto-reply text for easier auditing.
- Override in `~/.warelay/warelay.json`:

```json5
{
  logging: {
    level: "warn",
    file: "/tmp/warelay/custom.log"
  }
}
```

### Claude CLI setup (how we run it)
1) Install the official Claude CLI (e.g., `brew install anthropic-ai/cli/claude` or follow the Anthropic docs) and run `claude login` so it can read your API key.
2) In `warelay.json`, set `reply.mode` to `"command"` and point `command[0]` to `"claude"`; set `claudeOutputFormat` to `"text"` (or `"json"`/`"stream-json"` if you want warelay to parse and trim the JSON output).
3) (Optional) Add `bodyPrefix` to inject a system prompt and `session` settings to keep multi-turn context (`/new` resets by default).
4) Run `pnpm warelay relay --provider auto` (or `--provider web|twilio`) and send a WhatsApp message; warelay will queue the Claude call, stream typing indicators (Twilio provider), parse the result, and send back the text.

### Auto-reply parameter table (compact)
| Key | Type & default | Notes |
| --- | --- | --- |
| `inbound.allowFrom` | `string[]` (default: empty) | E.164 numbers allowed to trigger auto-reply (no `whatsapp:`). |
| `inbound.reply.mode` | `"text"` \| `"command"` (default: —) | Reply style. |
| `inbound.reply.text` | `string` (default: —) | Used when `mode=text`; templating supported. |
| `inbound.reply.command` | `string[]` (default: —) | Argv for `mode=command`; each element templated. Stdout (trimmed) is sent. |
| `inbound.reply.template` | `string` (default: —) | Injected as argv[1] (prompt prefix) before the body. |
| `inbound.reply.bodyPrefix` | `string` (default: —) | Prepended to `Body` before templating (great for system prompts). |
| `inbound.reply.timeoutSeconds` | `number` (default: `600`) | Command timeout. |
| `inbound.reply.claudeOutputFormat` | `"text"`\|`"json"`\|`"stream-json"` (default: —) | When command starts with `claude`, auto-adds `--output-format` + `-p/--print` and trims reply text. |
| `inbound.reply.session.scope` | `"per-sender"`\|`"global"` (default: `per-sender`) | Session bucket for conversation memory. |
| `inbound.reply.session.resetTriggers` | `string[]` (default: `["/new"]`) | Exact match or prefix (`/new hi`) resets session. |
| `inbound.reply.session.idleMinutes` | `number` (default: `60`) | Session expires after idle period. |
| `inbound.reply.session.store` | `string` (default: `~/.warelay/sessions.json`) | Custom session store path. |
| `inbound.reply.session.sessionArgNew` | `string[]` (default: `["--session-id","{{SessionId}}"]`) | Args injected for a new session run. |
| `inbound.reply.session.sessionArgResume` | `string[]` (default: `["--resume","{{SessionId}}"]`) | Args for resumed sessions. |
| `inbound.reply.session.sessionArgBeforeBody` | `boolean` (default: `true`) | Place session args before final body arg. |

Templating tokens: `{{Body}}`, `{{BodyStripped}}`, `{{From}}`, `{{To}}`, `{{MessageSid}}`, plus `{{SessionId}}` and `{{IsNewSession}}` when sessions are enabled.

## Webhook & Tailscale Flow
- `warelay webhook --ingress none` starts the local Express server on your chosen port/path; add `--reply "Got it"` for a static reply when no config file is present.
- `warelay webhook --ingress tailscale` enables Tailscale Funnel, prints the public URL (`https://<tailnet-host><path>`), starts the webhook, discovers the WhatsApp sender SID, and updates Twilio callbacks to the Funnel URL.
- If Funnel is not allowed on your tailnet, the CLI exits with guidance; you can still use `relay --provider twilio` to poll without webhooks.

## Troubleshooting Tips
- Send/receive issues: run `pnpm warelay status --limit 20 --lookback 240 --json` to inspect recent traffic.
- Auto-reply not firing: ensure sender is in `allowFrom` (or unset), and confirm `.env` + `warelay.json` are loaded (reload shell after edits).
- Web provider dropped: rerun `pnpm warelay login`; credentials live in `~/.warelay/credentials/`.
- Tailscale Funnel errors: update tailscale/tailscaled; check admin console that Funnel is enabled for this device.

## FAQ & Safety
- Twilio errors: **63016 “permission to send an SMS has not been enabled”** → ensure your number is WhatsApp-enabled; **63007 template not approved** → send a free-form session message within 24h or use an approved template; **63112 policy violation** → adjust content, shorten to <1600 chars, avoid links that trigger spam filters. Re-run `pnpm warelay status` to see the exact Twilio response body.
- Does this store my messages? warelay only writes `~/.warelay/warelay.json` (config), `~/.warelay/credentials/` (WhatsApp Web auth), and `~/.warelay/sessions.json` (session IDs + timestamps). It does **not** persist message bodies beyond the session store. Logs stream to stdout/stderr and also `/tmp/warelay/warelay.log` (configurable via `logging.file`).
- Personal WhatsApp safety: Automation on personal accounts can be rate-limited or logged out by WhatsApp. Use `--provider web` sparingly, keep messages human-like, and re-run `login` if the session is dropped.
- Limits to remember: WhatsApp text limit ~1600 chars; avoid rapid bursts—space sends by a few seconds; keep webhook replies under a couple seconds for good UX; command auto-replies time out after 600s by default.
- Deploy / keep running: Use `tmux` or `screen` for ad-hoc (`tmux new -s warelay -- pnpm warelay relay --provider twilio`). For long-running hosts, wrap `pnpm warelay relay ...` or `pnpm warelay webhook --ingress tailscale ...` in a systemd service or macOS LaunchAgent; ensure environment variables are loaded in that context.
- Rotating credentials: Update `.env` (Twilio keys), rerun your process; for Web provider, delete `~/.warelay/credentials/` and rerun `pnpm warelay login` to relink.
