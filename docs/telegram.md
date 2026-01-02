---
summary: "Telegram bot support status, capabilities, and configuration"
read_when:
  - Working on Telegram features or webhooks
---
# Telegram (Bot API)

Updated: 2025-12-07

Status: ready for bot-mode use with grammY (long-polling by default; webhook supported when configured). Text + media send, mention-gated group replies, per-group mention overrides, and optional proxy support are implemented.

## Goals
- Let you talk to Clawdis via a Telegram bot in DMs and groups.
- Share the same `main` session used by WhatsApp/WebChat; groups stay isolated as `telegram:group:<chatId>`.
- Keep transport routing deterministic: replies always go back to the surface they arrived on.

## How it will work (Bot API)
1) Create a bot with @BotFather and grab the token.
2) Configure Clawdis with `TELEGRAM_BOT_TOKEN` (or `telegram.botToken` in `~/.clawdis/clawdis.json`).
3) Run the gateway; it auto-starts Telegram only when a `telegram` config section exists **and** a bot token is set (unless `telegram.enabled = false`).
   - If you prefer env vars, still add `telegram: { enabled: true }` to `~/.clawdis/clawdis.json` and set `TELEGRAM_BOT_TOKEN`.
   - **Long-polling** is the default.
   - **Webhook mode** is enabled by setting `telegram.webhookUrl` (optionally `telegram.webhookSecret` / `telegram.webhookPath`).
     - The webhook listener currently binds to `0.0.0.0:8787` and serves `POST /telegram-webhook` by default.
     - If you need a different public port/host, set `telegram.webhookUrl` to the externally reachable URL and use a reverse proxy to forward to `:8787`.
4) Direct chats: user sends the first message; all subsequent turns land in the shared `main` session (default, no extra config).
5) Groups: add the bot, disable privacy mode (or make it admin) so it can read messages; group threads stay on `telegram:group:<chatId>` and require mention/command to trigger replies.
6) Optional allowlist: use `telegram.allowFrom` for direct chats by chat id (`123456789` or `telegram:123456789`).

## Capabilities & limits (Bot API)
- Sees only messages sent after it’s added to a chat; no pre-history access.
- Cannot DM users first; they must initiate. Channels are receive-only unless the bot is an admin poster.
- File size caps follow Telegram Bot API (up to 2 GB for documents; smaller for some media types).
- Typing indicators (`sendChatAction`) supported; outbound replies are sent as native replies to the triggering message (threaded where Telegram allows).

## Planned implementation details
- Library: grammY is the only client for send + gateway (fetch fallback removed); grammY throttler is enabled by default to stay under Bot API limits.
- Inbound normalization: maps Bot API updates to `MsgContext` with `Surface: "telegram"`, `ChatType: direct|group`, `SenderName`, `MediaPath`/`MediaType` when attachments arrive, `Timestamp`, and reply-to metadata (`ReplyToId`, `ReplyToBody`, `ReplyToSender`) when the user replies; reply context is appended to `Body` as a `[Replying to ...]` block; groups require @bot mention by default (override per chat in config).
- Outbound: text and media (photo/video/audio/document) with optional caption; chunked to limits. Typing cue sent best-effort.
- Config: `TELEGRAM_BOT_TOKEN` env or `telegram.botToken` required; `telegram.requireMention`, `telegram.groups`, `telegram.allowFrom`, `telegram.mediaMaxMb`, `telegram.proxy`, `telegram.webhookSecret`, `telegram.webhookUrl`, `telegram.webhookPath` supported.
  - Mention gating precedence (most specific wins): `telegram.groups.<chatId>.requireMention` → `telegram.groups._default.requireMention` → `telegram.requireMention` → default `true`.

Example config:
```json5
{
  telegram: {
    enabled: true,
    botToken: "123:abc",
    requireMention: true,
    groups: {
      _default: { requireMention: true },
      "123456789": { requireMention: false } // group chat id
    },
    allowFrom: ["123456789"], // direct chat ids allowed (or "*")
    mediaMaxMb: 5,
    proxy: "socks5://localhost:9050",
    webhookSecret: "mysecret",
    webhookPath: "/telegram-webhook",
    webhookUrl: "https://yourdomain.com/telegram-webhook"
  }
}
```
- Tests: grammY-based paths in `src/telegram/*.test.ts` cover DM + group gating; add more media and webhook cases as needed.

## Group etiquette
- Keep privacy mode off if you expect the bot to read all messages; with privacy on, it only sees commands/mentions.
- Make the bot an admin if you need it to send in restricted groups or channels.
- Mention the bot (`@yourbot`) or use commands to trigger; per-group overrides live in `telegram.groups` if you want always-on behavior.
- If you set both a global value and per-group overrides, the per-group value always wins.

## Roadmap
- ✅ Design and defaults (this doc)
- ✅ grammY long-poll gateway + text/media send
- ✅ Proxy + webhook helpers (setWebhook/deleteWebhook, health endpoint, optional public URL)
- ⏳ Add more grammY coverage (webhook payloads, media edge cases)

## Safety & ops
- Treat the bot token as a secret (equivalent to account control); prefer `TELEGRAM_BOT_TOKEN` or a locked-down config file (`chmod 600 ~/.clawdis/clawdis.json`).
- Respect Telegram rate limits (429s); grammY throttling is enabled by default.
- Use a test bot for development to avoid hitting production chats.
