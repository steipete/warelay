---
summary: "Group chat behavior across surfaces (WhatsApp/Telegram/Discord/iMessage)"
read_when:
  - Changing group chat behavior or mention gating
---
# Groups

Clawdis treats group chats consistently across surfaces: WhatsApp, Telegram, Discord, iMessage.

## Session keys
- Group sessions use `surface:group:<id>` session keys (rooms/channels use `surface:channel:<id>`).
- Direct chats use the main session (or per-sender if configured).
- Heartbeats are skipped for group sessions.

## Display labels
- UI labels use `displayName` when available, formatted as `surface:<token>`.
- `#room` is reserved for rooms/channels; group chats use `g-<slug>` (lowercase, spaces -> `-`, keep `#@+._-`).

## Mention gating (default)
Group messages require a mention unless overridden per group.

```json5
{
  routing: {
    groupChat: {
      requireMention: true,
      mentionPatterns: ["@clawd", "clawdbot", "\\+15555550123"],
      historyLimit: 50
    }
  }
}
```

Notes:
- `mentionPatterns` are case-insensitive regexes.
- Surfaces that provide explicit mentions still pass; patterns are a fallback.
- Telegram can override mention gating per chat via `telegram.groups.<chatId>.requireMention` and set group defaults with `telegram.groups._default`.

## Activation (owner-only)
Group owners can toggle per-group activation:
- `/activation mention`
- `/activation always`

Owner is determined by `whatsapp.allowFrom` (or the bot’s self E.164 when unset). Other surfaces currently ignore `/activation`.

## Context fields
Group inbound payloads set:
- `ChatType=group`
- `GroupSubject` (if known)
- `GroupMembers` (if known)
- `WasMentioned` (mention gating result)

The agent system prompt includes a group intro on the first turn of a new group session.

## iMessage specifics
- Prefer `chat_id:<id>` when routing or allowlisting.
- List chats: `imsg chats --limit 20`.
- Group replies always go back to the same `chat_id`.

## WhatsApp specifics
See `docs/group-messages.md` for WhatsApp-only behavior (history injection, mention handling details).
