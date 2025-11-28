# 📡 warelay — Send, receive, and auto-reply on WhatsApp.

<p align="center">
  <img src="README-header.png" alt="warelay header" width="640">
</p>

<p align="center">
  <a href="https://github.com/steipete/warelay/actions/workflows/ci.yml?branch=main"><img src="https://img.shields.io/github/actions/workflow/status/steipete/warelay/ci.yml?branch=main&style=for-the-badge" alt="CI status"></a>
  <a href="https://www.npmjs.com/package/warelay"><img src="https://img.shields.io/npm/v/warelay.svg?style=for-the-badge" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
</p>

Send, receive, auto-reply, and inspect WhatsApp messages over **Twilio** or your personal **WhatsApp Web** session. Ships with a one-command webhook setup (Tailscale Funnel + Twilio callback) and a configurable auto-reply engine (plain text or command/Claude/Opencode driven).

### Clawd (personal assistant)
I'm using warelay to run my personal, pro-active assistant, **Clawd**. Follow me on Twitter: [@steipete](https://twitter.com/steipete). This project is brand-new and there's a lot to discover. See the exact Claude setup in [`docs/clawd.md`](https://github.com/steipete/warelay/blob/main/docs/clawd.md).

We also support **Opencode**! See the setup guide for **Openclawd** in [`docs/openclawd.md`](https://github.com/steipete/warelay/blob/main/docs/openclawd.md).

I'm using warelay to run **my personal, pro-active assistant, Clawd**.
Follow me on Twitter - @steipete, this project is brand-new and there's a lot to discover.

## Quick Start (pick your engine)
Install from npm (global): `npm install -g warelay` (Node 22+). Then choose **one** path:

**A) Personal WhatsApp Web (preferred: no Twilio creds, fastest setup)**
1. Link your account: `warelay login` (scan the QR).
2. Send a message: `warelay send --to +12345550000 --message "Hi from warelay"` (add `--provider web` if you want to force the web session).
3. Stay online & auto-reply: `warelay relay --verbose` (uses Web when you're logged in; if you're not linked, start it with `--provider twilio`). When a Web session drops, the relay exits instead of silently falling back so you notice and re-login.

**B) Twilio WhatsApp number (for delivery status + webhooks)**
1. Copy `.env.example` → `.env`; set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` **or** `TWILIO_API_KEY`/`TWILIO_API_SECRET`, and `TWILIO_WHATSAPP_FROM=whatsapp:+19995550123` (optional `TWILIO_SENDER_SID`).
2. Send a message: `warelay send --to +12345550000 --message "Hi from warelay"`.
3. Receive replies:
   - Polling (no ingress): `warelay relay --provider twilio --interval 5 --lookback 10`
   - Webhook + public URL via Tailscale Funnel: `warelay webhook --ingress tailscale --port 42873 --path /webhook/whatsapp --verbose`

> Already developing locally? You can still run `pnpm install` and `pnpm warelay ...` from the repo, but end users only need the npm package.

## Main Features
- **Two providers:** Twilio (default) for reliable delivery + status; Web provider for quick personal sends/receives via QR login.
- **Auto-replies:** Static templates or external commands (Claude/Opencode-aware), with per-sender or global sessions and `/new` resets.
- Claude setup guide: see `docs/claude-config.md` for the exact Claude CLI configuration we support.
- Opencode setup guide: see `docs/openclawd.md` for Opencode CLI configuration.
- **Webhook in one go:** `warelay webhook --ingress tailscale` enables Tailscale Funnel, runs the webhook server, and updates the Twilio sender callback URL.
- **Polling fallback:** `relay` polls Twilio when webhooks aren’t available; works headless.
- **Status + delivery tracking:** `status` shows recent inbound/outbound; `send` can wait for final Twilio status.

## Command Cheat Sheet
| Command | What it does | Core flags |
| --- | --- | --- |
| `warelay send` | Send a WhatsApp message (Twilio or Web) | `--to <e164>` `--message <text>` `--wait <sec>` `--poll <sec>` `--provider twilio\|web` `--json` `--dry-run` `--verbose` |
| `warelay relay` | Auto-reply loop (poll Twilio or listen on Web) | `--provider <auto\|twilio\|web>` `--interval <sec>` `--lookback <min>` `--verbose` |
| `warelay status` | Show recent sent/received messages | `--limit <n>` `--lookback <min>` `--json` `--verbose` |
| `warelay heartbeat` | Trigger one heartbeat poll (web) | `--provider <auto\|web>` `--to <e164?>` `--session-id <uuid?>` `--all` `--verbose` |
| `warelay relay:heartbeat` | Run relay with an immediate heartbeat (no tmux) | `--provider <auto\|web>` `--verbose` |
| `warelay relay:heartbeat:tmux` | Start relay in tmux and fire a heartbeat on start (web) | _no flags_ |
| `warelay webhook` | Run inbound webhook (`ingress=tailscale` updates Twilio; `none` is local-only) | `--ingress tailscale\|none` `--port <port>` `--path <path>` `--reply <text>` `--verbose` `--yes` `--dry-run` |
| `warelay login` | Link personal WhatsApp Web via QR | `--verbose` |

### Sending media
- Twilio: `warelay send --to +1... --message "Hi" --media ./pic.jpg --serve-media` (needs `warelay webhook --ingress tailscale` or `--serve-media` to auto-host via Funnel; max 5 MB per file because of the built-in host).
- Web: `warelay send --provider web --media ./pic.jpg --message "Hi"` (local path or URL; no hosting needed). Web auto-detects media kind: images (≤6 MB), audio/voice or video (≤16 MB), other docs (≤100 MB). Images are resized to max 2048px and JPEG recompressed when the cap would be exceeded.
- Auto-replies can attach `mediaUrl` in `~/.warelay/warelay.json` (used alongside `text` when present). Web auto-replies honor `inbound.reply.mediaMaxMb` (default 5 MB) as a post-compression target but will never exceed the provider hard limits above.

### Voice notes (optional transcription)
- If you set `inbound.transcribeAudio.command`, warelay will run that CLI when inbound audio arrives (e.g., WhatsApp voice notes) and replace the Body with the transcript before templating/Claude.
- Example using OpenAI Whisper CLI (requires `OPENAI_API_KEY`):
  ```json5
  {
    inbound: {
      transcribeAudio: {
        command: [
          "openai",
          "api",
          "audio.transcriptions.create",
          "-m",
          "whisper-1",
          "-f",
          "{{MediaPath}}",
          "--response-format",
          "text"
        ],
        timeoutSeconds: 45
      },
      reply: { mode: "command", command: ["claude", "{{Body}}"] }
    }
  }
  ```
- Works for Web and Twilio providers; verbose mode logs when transcription runs. The command prompt includes the original media path plus a `Transcript:` block so models see both. If transcription fails, the original Body is used.

## Providers
- **Twilio (default):** needs `.env` creds + WhatsApp-enabled number; supports delivery tracking, polling, webhooks, and auto-reply typing indicators.
- **Web (`--provider web`):** uses your personal WhatsApp via Baileys; supports send/receive + auto-reply, but no delivery-status wait; cache lives in `~/.warelay/credentials/` (rerun `login` if logged out). If the Web socket closes, the relay exits instead of pivoting to Twilio.
- **Auto-select (`relay` only):** `--provider auto` picks Web when a cache exists at start, otherwise Twilio polling. It will not swap from Web to Twilio mid-run if the Web session drops.

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
      session: { scope: "per-sender", resetTriggers: ["/new"], idleMinutes: 60 },
      heartbeatMinutes: 10 // optional; pings Claude every 10m with "HEARTBEAT ultrathink" and only sends if it omits HEARTBEAT_OK
    }
  }
}
```

#### Heartbeat pings (command mode)
- When `heartbeatMinutes` is set (default 10 for `mode: "command"`), the relay periodically runs your command/Claude session with a heartbeat prompt.
- Heartbeat body is `HEARTBEAT ultrathink` (so the model can recognize the probe); if Claude replies exactly `HEARTBEAT_OK`, the message is suppressed; otherwise the reply (or media) is forwarded. Suppressions are still logged so you know the heartbeat ran.
- Override session freshness for heartbeats with `session.heartbeatIdleMinutes` (defaults to `session.idleMinutes`). Heartbeat skips do **not** bump `updatedAt`, so sessions still expire normally.
- Trigger one manually with `warelay heartbeat` (web provider only, `--verbose` prints session info). Use `--session-id <uuid>` to force resuming a specific Claude session, `--all` to ping every active session, `warelay relay:heartbeat` for a full relay run with an immediate heartbeat, or `--heartbeat-now` on `relay`/`relay:heartbeat:tmux`.
- When multiple active sessions exist, `warelay heartbeat` requires `--to <E.164>` or `--all`; if `allowFrom` is just `"*"`, you must choose a target with one of those flags.

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
3) (Optional) Add `bodyPrefix` to inject a system prompt and `session` settings to keep multi-turn context (`/new` resets by default). Set `sendSystemOnce: true` (plus an optional `sessionIntro`) to only send that prompt on the first turn of each session.
4) Run `pnpm warelay relay --provider auto` (or `--provider web|twilio`) and send a WhatsApp message; warelay will queue the Claude call, stream typing indicators (Twilio provider), parse the result, and send back the text.

### Auto-reply parameter table (compact)
| Key | Type & default | Notes |
| --- | --- | --- |
| `inbound.allowFrom` | `string[]` (default: empty) | E.164 numbers allowed to trigger auto-reply (no `whatsapp:`); `"*"` allows any sender. |
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
| `inbound.reply.session.sendSystemOnce` | `boolean` (default: `false`) | If `true`, only include the system prompt/template on the first turn of a session. |
| `inbound.reply.session.sessionIntro` | `string` | Optional intro text sent once per new session (prepended before the body when `sendSystemOnce` is used). |
| `inbound.reply.typingIntervalSeconds` | `number` (default: `8` for command replies) | How often to refresh typing indicators while the command/Claude run is in flight. |
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

### Maintainer notes (web provider internals)
- Web logic lives under `src/web/`: `session.ts` (auth/cache + provider pick), `login.ts` (QR login/logout), `outbound.ts`/`inbound.ts` (send/receive plumbing), `auto-reply.ts` (relay loop + reconnect/backoff), `media.ts` (download/resize helpers), and `reconnect.ts` (shared retry math). `test-helpers.ts` provides fixtures.
- The public surface remains the `src/provider-web.ts` barrel so existing imports keep working.
- Reconnects are capped and logged; no Twilio fallback occurs after a Web disconnect—restart the relay after re-linking.

## FAQ & Safety
- Twilio errors: **63016 “permission to send an SMS has not been enabled”** → ensure your number is WhatsApp-enabled; **63007 template not approved** → send a free-form session message within 24h or use an approved template; **63112 policy violation** → adjust content, shorten to <1600 chars, avoid links that trigger spam filters. Re-run `pnpm warelay status` to see the exact Twilio response body.
- Does this store my messages? warelay only writes `~/.warelay/warelay.json` (config), `~/.warelay/credentials/` (WhatsApp Web auth), and `~/.warelay/sessions.json` (session IDs + timestamps). It does **not** persist message bodies beyond the session store. Logs stream to stdout/stderr and also `/tmp/warelay/warelay.log` (configurable via `logging.file`).
- Personal WhatsApp safety: Automation on personal accounts can be rate-limited or logged out by WhatsApp. Use `--provider web` sparingly, keep messages human-like, and re-run `login` if the session is dropped.
- Limits to remember: WhatsApp text limit ~1600 chars; avoid rapid bursts—space sends by a few seconds; keep webhook replies under a couple seconds for good UX; command auto-replies time out after 600s by default.
- Deploy / keep running: Use `tmux` or `screen` for ad-hoc (`tmux new -s warelay -- pnpm warelay relay --provider twilio`). For long-running hosts, wrap `pnpm warelay relay ...` or `pnpm warelay webhook --ingress tailscale ...` in a systemd service or macOS LaunchAgent; ensure environment variables are loaded in that context.
- Rotating credentials: Update `.env` (Twilio keys), rerun your process; for Web provider, delete `~/.warelay/credentials/` and rerun `pnpm warelay login` to relink.
