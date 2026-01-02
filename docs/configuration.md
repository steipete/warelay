---
summary: "All configuration options for ~/.clawdis/clawdis.json with examples"
read_when:
  - Adding or modifying config fields
---
<!-- {% raw %} -->
# Configuration 🔧

CLAWDIS reads an optional **JSON5** config from `~/.clawdis/clawdis.json` (comments + trailing commas allowed).

If the file is missing, CLAWDIS uses safe-ish defaults (embedded Pi agent + per-sender sessions + workspace `~/clawd`). You usually only need a config to:
- restrict who can trigger the bot (`whatsapp.allowFrom`, `telegram.allowFrom`, etc.)
- tune group mention behavior (`routing.groupChat`)
- customize message prefixes (`messages`)
- set the agent’s workspace (`agent.workspace`)
- tune the embedded agent (`agent`) and session behavior (`session`)
- set the agent’s identity (`identity`)

## Minimal config (recommended starting point)

```json5
{
  agent: { workspace: "~/clawd" },
  whatsapp: { allowFrom: ["+15555550123"] }
}
```

## Common options

### `identity`

Optional agent identity used for defaults and UX. This is written by the macOS onboarding assistant.

If set, CLAWDIS derives defaults (only when you haven’t set them explicitly):
- `messages.responsePrefix` from `identity.emoji`
- `routing.groupChat.mentionPatterns` from `identity.name` (so “@Samantha” works in groups)

```json5
{
  identity: { name: "Samantha", theme: "helpful sloth", emoji: "🦥" }
}
```

### `wizard`

Metadata written by CLI wizards (`onboard`, `configure`, `doctor`, `update`).

```json5
{
  wizard: {
    lastRunAt: "2026-01-01T00:00:00.000Z",
    lastRunVersion: "2.0.0-beta5",
    lastRunCommit: "abc1234",
    lastRunCommand: "configure",
    lastRunMode: "local"
  }
}
```

### `logging`

- Default log file: `/tmp/clawdis/clawdis-YYYY-MM-DD.log`
- If you want a stable path, set `logging.file` to `/tmp/clawdis/clawdis.log`.
- Console output can be tuned separately via:
  - `logging.consoleLevel` (defaults to `info`, bumps to `debug` when `--verbose`)
  - `logging.consoleStyle` (`pretty` | `compact` | `json`)

```json5
{
  logging: {
    level: "info",
    file: "/tmp/clawdis/clawdis.log",
    consoleLevel: "info",
    consoleStyle: "pretty"
  }
}
```

### `whatsapp.allowFrom`

Allowlist of E.164 phone numbers that may trigger WhatsApp auto-replies.

```json5
{
  whatsapp: { allowFrom: ["+15555550123", "+447700900123"] }
}
```

### `routing.groupChat`

Group messages default to **require mention** (either metadata mention or regex patterns). Applies to WhatsApp, Telegram, Discord, and iMessage group chats.

```json5
{
  routing: {
    groupChat: {
      mentionPatterns: ["@clawd", "clawdbot", "clawd"],
      historyLimit: 50
    }
  }
}
```

### `routing.queue`

Controls how inbound messages behave when an agent run is already active.

```json5
{
  routing: {
    queue: {
      mode: "interrupt", // global default: queue | interrupt
      bySurface: {
        whatsapp: "interrupt",
        telegram: "interrupt",
        discord: "queue",
        imessage: "interrupt",
        webchat: "queue"
      }
    }
  }
}
```

### `web` (WhatsApp web provider)

WhatsApp runs through the gateway’s web provider. It starts automatically when a linked session exists.
Set `web.enabled: false` to keep it off by default.

```json5
{
  web: {
    enabled: true,
    heartbeatSeconds: 60,
    reconnect: {
      initialMs: 2000,
      maxMs: 120000,
      factor: 1.4,
      jitter: 0.2,
      maxAttempts: 0
    }
  }
}
```

### `telegram` (bot transport)

Clawdis starts Telegram only when a `telegram` config section exists. The bot token is resolved from `TELEGRAM_BOT_TOKEN` or `telegram.botToken`.
Set `telegram.enabled: false` to disable automatic startup.

```json5
{
  telegram: {
    enabled: true,
    botToken: "your-bot-token",
    requireMention: true,
    groups: {
      _default: { requireMention: true },
      "123456789": { requireMention: false } // group chat id
    },
    allowFrom: ["123456789"],
    mediaMaxMb: 5,
    proxy: "socks5://localhost:9050",
    webhookUrl: "https://example.com/telegram-webhook",
    webhookSecret: "secret",
    webhookPath: "/telegram-webhook"
  }
}
```
Mention gating precedence (most specific wins): `telegram.groups.<chatId>.requireMention` → `telegram.groups._default.requireMention` → `telegram.requireMention` → default `true`.

### `discord` (bot transport)

Configure the Discord bot by setting the bot token and optional gating:

```json5
{
  discord: {
    enabled: true,
    token: "your-bot-token",
    mediaMaxMb: 8,                          // clamp inbound media size
    enableReactions: true,                  // allow agent-triggered reactions
    slashCommand: {                         // user-installed app slash commands
      enabled: true,
      name: "clawd",
      sessionPrefix: "discord:slash",
      ephemeral: true
    },
    dm: {
      enabled: true,                        // disable all DMs when false
      allowFrom: ["1234567890", "steipete"], // optional DM allowlist (ids or names)
      groupEnabled: false,                 // enable group DMs
      groupChannels: ["clawd-dm"]          // optional group DM allowlist
    },
    guilds: {
      "123456789012345678": {               // guild id (preferred) or slug
        slug: "friends-of-clawd",
        requireMention: false,              // per-guild default
        users: ["987654321098765432"],      // optional per-guild user allowlist
        channels: {
          general: { allow: true },
          help: { allow: true, requireMention: true }
        }
      }
    },
    historyLimit: 20                        // include last N guild messages as context
  }
}
```

Clawdis starts Discord only when a `discord` config section exists. The token is resolved from `DISCORD_BOT_TOKEN` or `discord.token` (unless `discord.enabled` is `false`). Use `user:<id>` (DM) or `channel:<id>` (guild channel) when specifying delivery targets for cron/CLI commands.
Guild slugs are lowercase with spaces replaced by `-`; channel keys use the slugged channel name (no leading `#`). Prefer guild ids as keys to avoid rename ambiguity.

### `imessage` (imsg CLI)

Clawdis spawns `imsg rpc` (JSON-RPC over stdio). No daemon or port required.

```json5
{
  imessage: {
    enabled: true,
    cliPath: "imsg",
    dbPath: "~/Library/Messages/chat.db",
    allowFrom: ["+15555550123", "user@example.com", "chat_id:123"],
    includeAttachments: false,
    mediaMaxMb: 16,
    service: "auto",
    region: "US"
  }
}
```

Notes:
- Requires Full Disk Access to the Messages DB.
- The first send will prompt for Messages automation permission.
- Prefer `chat_id:<id>` targets. Use `imsg chats --limit 20` to list chats.

### `agent.workspace`

Sets the **single global workspace directory** used by the agent for file operations.

Default: `~/clawd`.

```json5
{
  agent: { workspace: "~/clawd" }
}
```

### `messages`

Controls inbound/outbound prefixes and timestamps.

```json5
{
  messages: {
    messagePrefix: "[clawdis]",
    responsePrefix: "🦞",
    timestampPrefix: "Europe/London"
  }
}
```

### `talk`

Defaults for Talk mode (macOS/iOS/Android). Voice IDs fall back to `ELEVENLABS_VOICE_ID` or `SAG_VOICE_ID` when unset.
`apiKey` falls back to `ELEVENLABS_API_KEY` (or the gateway’s shell profile) when unset.
`voiceAliases` lets Talk directives use friendly names (e.g. `"voice":"Clawd"`).

```json5
{
  talk: {
    voiceId: "elevenlabs_voice_id",
    voiceAliases: {
      Clawd: "EXAVITQu4vr4xnSDxMaL",
      Roger: "CwhRBWXzGAHq8TQ4Fs17"
    },
    modelId: "eleven_v3",
    outputFormat: "mp3_44100_128",
    apiKey: "elevenlabs_api_key",
    interruptOnSpeech: true
  }
}
```

### `agent`

Controls the embedded agent runtime (model/thinking/verbose/timeouts).
`allowedModels` lets `/model` list/filter and enforce a per-session allowlist
(omit to show the full catalog).
`modelAliases` adds short names for `/model` (alias -> provider/model).

```json5
{
  agent: {
    model: "anthropic/claude-opus-4-5",
    allowedModels: [
      "anthropic/claude-opus-4-5",
      "anthropic/claude-sonnet-4-1"
    ],
    modelAliases: {
      Opus: "anthropic/claude-opus-4-5",
      Sonnet: "anthropic/claude-sonnet-4-1"
    },
    thinkingDefault: "low",
    verboseDefault: "off",
    timeoutSeconds: 600,
    mediaMaxMb: 5,
    heartbeat: {
      every: "30m",
      target: "last"
    },
    maxConcurrent: 3,
    bash: {
      backgroundMs: 20000,
      timeoutSec: 1800,
      cleanupMs: 1800000
    },
    contextTokens: 200000
  }
}
```

`agent.model` should be set as `provider/model` (e.g. `anthropic/claude-opus-4-5`).
If `modelAliases` is configured, you may also use the alias key (e.g. `Opus`).
If you omit the provider, CLAWDIS currently assumes `anthropic` as a temporary
deprecation fallback.
Z.AI models are available as `zai/<model>` (e.g. `zai/glm-4.7`) and require
`ZAI_API_KEY` (or legacy `Z_AI_API_KEY`) in the environment.

`agent.heartbeat` configures periodic heartbeat runs:
- `every`: duration string (`ms`, `s`, `m`, `h`); default unit minutes. Omit or set
  `0m` to disable.
- `model`: optional override model for heartbeat runs (`provider/model`).
- `target`: optional delivery channel (`last`, `whatsapp`, `telegram`, `discord`, `imessage`, `none`). Default: `last`.
- `to`: optional recipient override (E.164 for WhatsApp, chat id for Telegram).
- `prompt`: optional override for the heartbeat body (default: `HEARTBEAT`).

`agent.bash` configures background bash defaults:
- `backgroundMs`: time before auto-background (ms, default 20000)
- `timeoutSec`: auto-kill after this runtime (seconds, default 1800)
- `cleanupMs`: how long to keep finished sessions in memory (ms, default 1800000)

`agent.maxConcurrent` sets the maximum number of embedded agent runs that can
execute in parallel across sessions. Each session is still serialized (one run
per session key at a time). Default: 1.

### `models` (custom providers + base URLs)

Clawdis uses the **pi-coding-agent** model catalog. You can add custom providers
(LiteLLM, local OpenAI-compatible servers, Anthropic proxies, etc.) by writing
`~/.clawdis/agent/models.json` or by defining the same schema inside your
Clawdis config under `models.providers`.

When `models.providers` is present, Clawdis writes/merges a `models.json` into
`~/.clawdis/agent/` on startup:
- default behavior: **merge** (keeps existing providers, overrides on name)
- set `models.mode: "replace"` to overwrite the file contents

Select the model via `agent.model` (provider/model).

```json5
{
  agent: { model: "custom-proxy/llama-3.1-8b" },
  models: {
    mode: "merge",
    providers: {
      "custom-proxy": {
        baseUrl: "http://localhost:4000/v1",
        apiKey: "LITELLM_KEY",
        api: "openai-completions",
        models: [
          {
            id: "llama-3.1-8b",
            name: "Llama 3.1 8B",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 32000
          }
        ]
      }
    }
  }
}
```

### Local models (LM Studio) — recommended setup

Best current local setup (what we’re running): **MiniMax M2.1** on a beefy Mac Studio
via **LM Studio** using the **Responses API**.

```json5
{
  agent: {
    model: "Minimax",
    allowedModels: [
      "anthropic/claude-opus-4-5",
      "lmstudio/minimax-m2.1-gs32"
    ],
    modelAliases: {
      Opus: "anthropic/claude-opus-4-5",
      Minimax: "lmstudio/minimax-m2.1-gs32"
    }
  },
  models: {
    mode: "merge",
    providers: {
      lmstudio: {
        baseUrl: "http://127.0.0.1:1234/v1",
        apiKey: "lmstudio",
        api: "openai-responses",
        models: [
          {
            id: "minimax-m2.1-gs32",
            name: "MiniMax M2.1 GS32",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 196608,
            maxTokens: 8192
          }
        ]
      }
    }
  }
}
```

Notes:
- LM Studio must have the model loaded and the local server enabled (default URL above).
- Responses API enables clean reasoning/output separation; WhatsApp sees only final text.
- Adjust `contextWindow`/`maxTokens` if your LM Studio context length differs.

Notes:
- Supported APIs: `openai-completions`, `openai-responses`, `anthropic-messages`,
  `google-generative-ai`
- Use `authHeader: true` + `headers` for custom auth needs.
- Override the agent config root with `CLAWDIS_AGENT_DIR` (or `PI_CODING_AGENT_DIR`)
  if you want `models.json` stored elsewhere.

### `session`

Controls session scoping, idle expiry, reset triggers, and where the session store is written.

```json5
{
  session: {
    scope: "per-sender",
    idleMinutes: 60,
    resetTriggers: ["/new", "/reset"],
    store: "~/.clawdis/sessions/sessions.json",
    mainKey: "main"
  }
}
```

### `skills` (skills config)

Controls bundled allowlist, install preferences, extra skill folders, and per-skill
overrides. Applies to **bundled** skills and `~/.clawdis/skills` (workspace skills
still win on name conflicts).

Fields:
- `allowBundled`: optional allowlist for **bundled** skills only. If set, only those
  bundled skills are eligible (managed/workspace skills unaffected).
- `load.extraDirs`: additional skill directories to scan (lowest precedence).
- `install.preferBrew`: prefer brew installers when available (default: true).
- `install.nodeManager`: node installer preference (`npm` | `pnpm` | `yarn`, default: npm).
- `entries.<skillKey>`: per-skill config overrides.

Per-skill fields:
- `enabled`: set `false` to disable a skill even if it’s bundled/installed.
- `env`: environment variables injected for the agent run (only if not already set).
- `apiKey`: optional convenience for skills that declare a primary env var (e.g. `nano-banana-pro` → `GEMINI_API_KEY`).

Example:

```json5
{
  skills: {
    allowBundled: ["brave-search", "gemini"],
    load: {
      extraDirs: [
        "~/Projects/agent-scripts/skills",
        "~/Projects/oss/some-skill-pack/skills"
      ]
    },
    install: {
      preferBrew: true,
      nodeManager: "npm"
    },
    entries: {
      "nano-banana-pro": {
        apiKey: "GEMINI_KEY_HERE",
        env: {
          GEMINI_API_KEY: "GEMINI_KEY_HERE"
        }
      },
      peekaboo: { enabled: true },
      sag: { enabled: false }
    }
  }
}
```

### `browser` (clawd-managed Chrome)

Clawdis can start a **dedicated, isolated** Chrome/Chromium instance for clawd and expose a small loopback control server.

Defaults:
- enabled: `true`
- control URL: `http://127.0.0.1:18791` (CDP uses `18792`)
- CDP URL: `http://127.0.0.1:18792` (control URL + 1)
- profile color: `#FF4500` (lobster-orange)
- Note: the control server is started by the running gateway (Clawdis.app menubar, or `clawdis gateway`).

```json5
{
  browser: {
    enabled: true,
    controlUrl: "http://127.0.0.1:18791",
    // cdpUrl: "http://127.0.0.1:18792", // override for remote CDP
    color: "#FF4500",
    // Advanced:
    // headless: false,
    // noSandbox: false,
    // executablePath: "/usr/bin/chromium",
    // attachOnly: false, // set true when tunneling a remote CDP to localhost
  }
}
```

### `ui` (Appearance)

Optional accent color used by the native apps for UI chrome (e.g. Talk Mode bubble tint).

If unset, clients fall back to a muted light-blue.

```json5
{
  ui: {
    seamColor: "#FF4500" // hex (RRGGBB or #RRGGBB)
  }
}
```

### `gateway` (Gateway server mode + bind)

Use `gateway.mode` to explicitly declare whether this machine should run the Gateway.

Defaults:
- mode: **unset** (treated as “do not auto-start”)
- bind: `loopback`

```json5
{
  gateway: {
    mode: "local", // or "remote"
    bind: "loopback",
    // controlUi: { enabled: true }
    // auth: { mode: "token", token: "your-token" } // token is for multi-machine CLI access
    // tailscale: { mode: "off" | "serve" | "funnel" }
  }
}
```

Notes:
- `clawdis gateway` refuses to start unless `gateway.mode` is set to `local` (or you pass the override flag).

Auth and Tailscale:
- `gateway.auth.mode` sets the handshake requirements (`token` or `password`).
- `gateway.auth.token` stores the shared token for token auth (used by the CLI on the same machine).
- When `gateway.auth.mode` is set, only that method is accepted (plus optional Tailscale headers).
- `gateway.auth.password` can be set here, or via `CLAWDIS_GATEWAY_PASSWORD` (recommended).
- `gateway.auth.allowTailscale` controls whether Tailscale identity headers can satisfy auth.
- `gateway.tailscale.mode: "serve"` uses Tailscale Serve (tailnet only, loopback bind).
- `gateway.tailscale.mode: "funnel"` exposes the dashboard publicly; requires auth.
- `gateway.tailscale.resetOnExit` resets Serve/Funnel config on shutdown.

Remote client defaults (CLI):
- `gateway.remote.url` sets the default Gateway WebSocket URL for CLI calls when `gateway.mode = "remote"`.
- `gateway.remote.token` supplies the token for remote calls (leave unset for no auth).
- `gateway.remote.password` supplies the password for remote calls (leave unset for no auth).

```json5
{
  gateway: {
    mode: "remote",
    remote: {
      url: "ws://gateway.tailnet:18789",
      token: "your-token",
      password: "your-password"
    }
  }
}
```

### `hooks` (Gateway webhooks)

Enable a simple HTTP webhook surface on the Gateway HTTP server.

Defaults:
- enabled: `false`
- path: `/hooks`
- maxBodyBytes: `262144` (256 KB)

```json5
{
  hooks: {
    enabled: true,
    token: "shared-secret",
    path: "/hooks",
    presets: ["gmail"],
    transformsDir: "~/.clawdis/hooks",
    mappings: [
      {
        match: { path: "gmail" },
        action: "agent",
        wakeMode: "now",
        name: "Gmail",
        sessionKey: "hook:gmail:{{messages[0].id}}",
        messageTemplate:
          "From: {{messages[0].from}}\nSubject: {{messages[0].subject}}\n{{messages[0].snippet}}",
      },
    ],
  }
}
```

Requests must include the hook token:
- `Authorization: Bearer <token>` **or**
- `x-clawdis-token: <token>` **or**
- `?token=<token>`

Endpoints:
- `POST /hooks/wake` → `{ text, mode?: "now"|"next-heartbeat" }`
- `POST /hooks/agent` → `{ message, name?, sessionKey?, wakeMode?, deliver?, channel?, to?, thinking?, timeoutSeconds? }`
- `POST /hooks/<name>` → resolved via `hooks.mappings`

`/hooks/agent` always posts a summary into the main session (and can optionally trigger an immediate heartbeat via `wakeMode: "now"`).

Mapping notes:
- `match.path` matches the sub-path after `/hooks` (e.g. `/hooks/gmail` → `gmail`).
- `match.source` matches a payload field (e.g. `{ source: "gmail" }`) so you can use a generic `/hooks/ingest` path.
- Templates like `{{messages[0].subject}}` read from the payload.
- `transform` can point to a JS/TS module that returns a hook action.

Gmail helper config (used by `clawdis hooks gmail setup` / `run`):

```json5
{
  hooks: {
    gmail: {
      account: "clawdbot@gmail.com",
      topic: "projects/<project-id>/topics/gog-gmail-watch",
      subscription: "gog-gmail-watch-push",
      pushToken: "shared-push-token",
      hookUrl: "http://127.0.0.1:18789/hooks/gmail",
      includeBody: true,
      maxBytes: 20000,
      renewEveryMinutes: 720,
      serve: { bind: "127.0.0.1", port: 8788, path: "/" },
      tailscale: { mode: "funnel", path: "/gmail-pubsub" },
    }
  }
}
```

Note: when `tailscale.mode` is on, Clawdis defaults `serve.path` to `/` so
Tailscale can proxy `/gmail-pubsub` correctly (it strips the set-path prefix).

### `canvasHost` (LAN/tailnet Canvas file server + live reload)

The Gateway serves a directory of HTML/CSS/JS over HTTP so iOS/Android nodes can simply `canvas.navigate` to it.

Default root: `~/clawd/canvas`  
Default port: `18793` (chosen to avoid the clawd browser CDP port `18792`)  
The server listens on the **bridge bind host** (LAN or Tailnet) so nodes can reach it.

The server:
- serves files under `canvasHost.root`
- injects a tiny live-reload client into served HTML
- watches the directory and broadcasts reloads over a WebSocket endpoint at `/__clawdis/ws`
- auto-creates a starter `index.html` when the directory is empty (so you see something immediately)
- also serves A2UI at `/__clawdis__/a2ui/` and is advertised to nodes as `canvasHostUrl`
  (always used by nodes for Canvas/A2UI)

```json5
{
  canvasHost: {
    root: "~/clawd/canvas",
    port: 18793
  }
}
```

Disable with:
- config: `canvasHost: { enabled: false }`
- env: `CLAWDIS_SKIP_CANVAS_HOST=1`

### `bridge` (node bridge server)

The Gateway can expose a simple TCP bridge for nodes (iOS/Android), typically on port `18790`.

Defaults:
- enabled: `true`
- port: `18790`
- bind: `lan` (binds to `0.0.0.0`)

Bind modes:
- `lan`: `0.0.0.0` (reachable on any interface, including LAN/Wi‑Fi and Tailscale)
- `tailnet`: bind only to the machine’s Tailscale IP (recommended for Vienna ⇄ London)
- `loopback`: `127.0.0.1` (local only)
- `auto`: prefer tailnet IP if present, else `lan`

```json5
{
  bridge: {
    enabled: true,
    port: 18790,
    bind: "tailnet"
  }
}
```

### `discovery.wideArea` (Wide-Area Bonjour / unicast DNS‑SD)

When enabled, the Gateway writes a unicast DNS-SD zone for `_clawdis-bridge._tcp` under `~/.clawdis/dns/` using the standard discovery domain `clawdis.internal.`

To make iOS/Android discover across networks (Vienna ⇄ London), pair this with:
- a DNS server on the gateway host serving `clawdis.internal.` (CoreDNS is recommended)
- Tailscale **split DNS** so clients resolve `clawdis.internal` via that server

One-time setup helper (gateway host):

```bash
clawdis dns setup --apply
```

```json5
{
  discovery: { wideArea: { enabled: true } }
}
```

## Template variables

Template placeholders are expanded in `routing.transcribeAudio.command` (and any future templated command fields).

| Variable | Description |
|----------|-------------|
| `{{Body}}` | Full inbound message body |
| `{{BodyStripped}}` | Body with group mentions stripped (best default for agents) |
| `{{From}}` | Sender identifier (E.164 for WhatsApp; may differ per surface) |
| `{{To}}` | Destination identifier |
| `{{MessageSid}}` | Provider message id (when available) |
| `{{SessionId}}` | Current session UUID |
| `{{IsNewSession}}` | `"true"` when a new session was created |
| `{{MediaUrl}}` | Inbound media pseudo-URL (if present) |
| `{{MediaPath}}` | Local media path (if downloaded) |
| `{{MediaType}}` | Media type (image/audio/document/…) |
| `{{Transcript}}` | Audio transcript (when enabled) |
| `{{ChatType}}` | `"direct"` or `"group"` |
| `{{GroupSubject}}` | Group subject (best effort) |
| `{{GroupMembers}}` | Group members preview (best effort) |
| `{{SenderName}}` | Sender display name (best effort) |
| `{{SenderE164}}` | Sender phone number (best effort) |
| `{{Surface}}` | Surface hint (whatsapp|telegram|discord|imessage|webchat|…) |

## Cron (Gateway scheduler)

Cron is a Gateway-owned scheduler for wakeups and scheduled jobs. See [Cron + wakeups](./cron.md) for the full RFC and CLI examples.

```json5
{
  cron: {
    enabled: true,
    maxConcurrentRuns: 2
  }
}
```

---

*Next: [Agent Runtime](./agent.md)* 🦞
<!-- {% endraw %} -->
