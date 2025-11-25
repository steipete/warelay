# 📡 warelay — WhatsApp Relay CLI (Twilio)

Small TypeScript CLI to send, receive, auto-reply, and inspect WhatsApp messages via Twilio. Works in polling mode or webhook mode (with Tailscale Funnel helper).

You can also talk to WhatsApp directly with a personal WhatsApp Web session (QR login) via `--provider web`—no Twilio needed for send/receive in that mode.

## What it can do

- Send and track delivery for WhatsApp messages over Twilio.
- Auto-reply via webhook or polling, with Claude-backed command replies or simple text templates.
- Run entirely on your personal WhatsApp Web session (`--provider web`) for direct messaging without Twilio.
- One-shot `up` command to launch webhook server, publish via Tailscale Funnel, and point Twilio callbacks automatically.

## Quick Start

1) Install: `pnpm install`  
2) Configure `.env` (see `.env.example`): set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` (or `TWILIO_API_KEY`/`TWILIO_API_SECRET`), and `TWILIO_WHATSAPP_FROM=whatsapp:+15551234567`. Optional: `TWILIO_SENDER_SID` if you don’t want auto-discovery.  
3) Send a test (Twilio): `pnpm warelay send --to +12345550000 --message "Hi from warelay"`  
   Dry run without sending: `pnpm warelay send --to +12345550000 --message "Hi" --dry-run`  
   Send direct via personal WhatsApp: `pnpm warelay web:login` (scan QR once) then `pnpm warelay send --provider web --to +12345550000 --message "Hi from warelay"`  
4) Run auto-replies in polling mode (no public URL needed):  
   `pnpm warelay relay --provider twilio --interval 5 --lookback 10 --verbose`  
5) Prefer webhooks? Launch everything in one step (webhook + Tailscale Funnel + Twilio callback):  
   `pnpm warelay up --port 42873 --path /webhook/whatsapp --verbose`

## Modes at a Glance

- **Polling (`relay --provider twilio`)**: Periodically fetch inbound messages to your WhatsApp number. Easiest to start; no ingress needed. Auto-replies still run.
- **Webhook (`webhook` / `up`)**: Push delivery from Twilio. `webhook` runs the server locally; `up` also enables Tailscale Funnel and points the Twilio sender/webhook to your public Funnel URL (with fallbacks to phone number and messaging service).

## Providers (choose per command)

- **Twilio (default)** — full feature set: send, wait/poll delivery, status, inbound polling/webhook, auto-replies. Requires `.env` Twilio creds and a WhatsApp-enabled number (`TWILIO_WHATSAPP_FROM`).
- **Web (`--provider web`)** — direct messaging through your personal WhatsApp account (no Twilio). Supports outbound sends and inbound auto-replies when you run `pnpm warelay relay --provider web`. No delivery-status polling for web sends (WhatsApp Web doesn’t expose it). Setup: `pnpm warelay web:login` (alias: `pnpm warelay login`) then either send with `--provider web` or keep `relay --provider web` running. Session data lives in `~/.warelay/credentials.json`; if logged out, rerun `web:login`/`login`. Use at your own risk (personal-account automation can be rate-limited or logged out by WhatsApp).

## Common Commands

- Send: `pnpm warelay send --to +12345550000 --message "Hello" --wait 20 --poll 2`
- Send (JSON output): `pnpm warelay send --to +12345550000 --message "Hello" --json`
- Send via personal WhatsApp Web: first `pnpm warelay web:login` (alias: `pnpm warelay login`, scan QR), then `pnpm warelay send --provider web --to +12345550000 --message "Hi"`
- Auto-replies (auto provider): `pnpm warelay relay` (uses web if logged in, otherwise twilio poll)
- Auto-replies (force web): `pnpm warelay relay --provider web`
- Auto-replies (force Twilio poll): `pnpm warelay relay --provider twilio --interval 5 --lookback 10 --verbose`
- Webhook only: `pnpm warelay webhook --port 42873 --path /webhook/whatsapp --verbose`
- Webhook + Funnel + Twilio update: `pnpm warelay up --port 42873 --path /webhook/whatsapp --verbose`
- Status (recent sent/received): `pnpm warelay status --limit 20 --lookback 240` (add `--json` for machine-readable)

## Auto-Reply Config (JSON5 at `~/.warelay/warelay.json`)

### Claude-style example (your current setup)
```json5
{
  inbound: {
    allowFrom: ["+436769770569"], // optional allowlist (E.164, no whatsapp: prefix)
    reply: {
      mode: "command",
      bodyPrefix: "You are a helpful assistant running on the user's Mac. User writes messages via WhatsApp and you respond. You want to be concise in your responses, at most 1000 characters.\n\n",
      command: [
        "claude",
        "--dangerously-skip-permissions",
        "{{BodyStripped}}"
      ],
      claudeOutputFormat: "text", // forces --output-format text and adds -p/--print when missing
      session: {
        scope: "per-sender",
        resetTriggers: ["/new"],
        idleMinutes: 60,
        sessionArgNew: ["--session-id", "{{SessionId}}"],
        sessionArgResume: ["--resume", "{{SessionId}}"],
        sessionArgBeforeBody: true
      }
    }
  }
}
```

### Claude CLI integration

- When `command[0]` is `claude`, set `claudeOutputFormat` to `"text"`, `"json"`, or `"stream-json"` and warelay will inject `--output-format` and `-p/--print` automatically.
- For `"json"`/`"stream-json"`, warelay parses Claude's JSON payload and sends just the text content to WhatsApp while keeping the full JSON in logs for debugging.
- If you omit `claudeOutputFormat`, warelay leaves your args untouched (useful for custom Claude flags).
- The config loader validates `warelay.json` (mode/text/command/claudeOutputFormat/session shape) and logs warnings for invalid combos instead of failing later at runtime.

### Running without Twilio (personal WhatsApp Web)

- Log in once: `pnpm warelay web:login` (or `pnpm warelay login`), scan the QR in your terminal/browser. Credentials are stored locally at `~/.warelay/credentials.json`.
- Send: `pnpm warelay send --provider web --to +12345550000 --message "Hi"`.
- Auto-reply loop: `pnpm warelay relay --provider web --interval 5 --lookback 10`. Typing indicators are skipped in this mode, but text replies still work.
- You can mix modes: use Twilio for reliable delivery/status, switch to web for quick personal sends. Each command decides the provider independently.

### Simple text echo
```json5
{
  inbound: {
    reply: { mode: "text", text: "Echo: {{Body}}" }
  }
}
```

Notes:
- Templates support `{{Body}}`, `{{BodyStripped}}`, `{{From}}`, `{{To}}`, `{{MessageSid}}`, plus `{{SessionId}}`/`{{IsNewSession}}` when session reuse is enabled.
- `/new` (or any `resetTriggers` value) resets the session. `/new ask…` resets and sends `ask…` as the prompt (via `BodyStripped`).
- When an auto-reply starts (text or command), warelay sends a WhatsApp typing indicator tied to the inbound `MessageSid`.

## Troubleshooting Delivery

- Auto-reply send failures now print in red with Twilio code/status and the response body (e.g., policy violation 63112). Watch terminal output when running `relay`, `webhook`, or `up`.
- Check recent messages: `pnpm warelay status --limit 20 --lookback 240`.
- If you must resend while a reply is long-running, keep messages <1600 chars (WhatsApp limit) and avoid restricted content/templates.

## Options Reference

| Field | Type / Values | Default | Description |
| --- | --- | --- | --- |
| `inbound.allowFrom` | `string[]` | empty | Allowlist of E.164 numbers (no `whatsapp:`). If set, only these trigger auto-replies. |
| `inbound.reply.mode` | `"text"` \| `"command"` | — | Auto-reply type. |
| `inbound.reply.text` | `string` | — | Reply body for text mode; templated. |
| `inbound.reply.command` | `string[]` | — | Argv to run for command mode; templated per element. Stdout (trimmed) is sent. |
| `inbound.reply.template` | `string` | — | Optional string inserted as second argv element (prompt prefix). |
| `inbound.reply.bodyPrefix` | `string` | — | Prepends to `Body` before templating (ideal for system instructions). |
| `inbound.reply.session.scope` | `"per-sender" \| "global"` | `per-sender` | Session key: one per sender or single global chat. |
| `inbound.reply.session.resetTriggers` | `string[]` | `["/new"]` | Any entry acts as both exact reset token and prefix (`/new hi`). |
| `inbound.reply.session.idleMinutes` | `number` | `60` | Expire and recreate session after this idle time. |
| `inbound.reply.session.sessionArgNew` | `string[]` | `["--session-id","{{SessionId}}"]` | Args inserted for a new session run. |
| `inbound.reply.session.sessionArgResume` | `string[]` | `["--resume","{{SessionId}}"]` | Args inserted when resuming an existing session. |
| `inbound.reply.session.sessionArgBeforeBody` | `boolean` | `true` | Place session args before the final body argument. |
| `inbound.reply.claudeOutputFormat` | `"text" \| "json" \| "stream-json"` | — | When `command[0]` is `claude`, force this output format and auto-add `-p/--print` so Claude exits after emitting output. |
| `inbound.reply.timeoutSeconds` | `number` | 600 | Command timeout. |

## Dev Notes

- During dev you can run without building: `pnpm dev -- <subcommand>` (e.g., `pnpm dev -- send --to +1...`).
- Stop relay/webhook with `Ctrl+C`. CLI uses `pnpm` and `tsx`; no build required for local runs.
