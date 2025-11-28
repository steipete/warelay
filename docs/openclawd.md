# Building Your Own AI Personal Assistant with warelay (Opencode Edition)

> **TL;DR:** warelay lets you turn Opencode into a proactive personal assistant that lives in your pocket via WhatsApp. It can check in on you, remember context across conversations, run commands on your Mac, and even wake you up with music. This doc shows you how.

---

## ⚠️ Warning: Here Be Dragons

**This setup gives an AI full access to your computer.** Before you proceed, understand what you're signing up for:

- 🔓 **Opencode runs in Autonomous Mode** by default. It will execute commands without asking.
- 🤖 **AI makes mistakes** - it might delete files, send emails, or do things you didn't intend
- 🔥 **Heartbeats run autonomously** - your AI acts even when you're not watching
- 📱 **WhatsApp is not encrypted E2E here** - messages pass through your Mac in plaintext

**The good news:** Opencode is powerful and flexible.

**Start conservative:**
1. Monitor the logs initially.
2. Set `heartbeatMinutes: 0` to disable proactive pings initially.
3. Use a test phone number in `allowFrom` first.

This is experimental software running experimental AI. **You are responsible for what your AI does.**

---

## Prerequisites: The Two-Phone Setup

**Important:** You need a **separate phone number** for your AI assistant. Here's why and how:

### Why a Dedicated Number?

warelay uses WhatsApp Web to receive messages. If you link your personal WhatsApp, *you* become the assistant - every message to you goes to the AI. Instead, give Openclawd its own identity:

- 📱 **Get a second SIM** - cheap prepaid SIM, eSIM, or old phone with a number
- 💬 **Install WhatsApp** on that phone and verify the number
- 🔗 **Link to warelay** - run `warelay login` and scan the QR with that phone's WhatsApp
- ✉️ **Message your AI** - now you (and others) can text that number to reach Openclawd

### The Setup

```
Your Phone (personal)          Second Phone (AI)
┌─────────────────┐           ┌─────────────────┐
│  Your WhatsApp  │  ──────▶  │  AI's WhatsApp  │
│  +1-555-YOU     │  message  │  +1-555-CLAWD   │
└─────────────────┘           └────────┬────────┘
                                       │ linked via QR
                                       ▼
                              ┌─────────────────┐
                              │  Your Mac       │
                              │  (warelay)      │
                              │  Opencode CLI   │
                              └─────────────────┘
```

The second phone just needs to stay on and connected to the internet occasionally (WhatsApp Web stays linked for ~14 days without the phone being online).

---

## Meet Openclawd 👋

Openclawd is your personal AI assistant built on warelay using Opencode. Here's what makes it special:

- **Always available** via WhatsApp - no app switching, works on any device
- **Proactive heartbeats** - Openclawd checks in every 10 minutes and can alert you to things (low battery, calendar reminders, anything it notices)
- **Persistent memory** - conversations span days/weeks with full context
- **Full Mac access** - can run commands, take screenshots, control Spotify, read/write files
- **Personal workspace** - has its own folder (`~/openclawd`) where it stores notes, memories, and artifacts

The magic is in the combination: WhatsApp's ubiquity + Opencode's intelligence + warelay's plumbing + your Mac's capabilities.

## Prerequisites

- Node 22+, `warelay` installed: `npm install -g warelay`
- Opencode CLI installed and logged in:
  ```sh
  npm install -g opencode-ai
  opencode auth login
  ```

## The Config That Powers Openclawd

This is the config for running Openclawd (`~/.warelay/warelay.json`):

```json5
{
  logging: { level: "trace", file: "/tmp/warelay/warelay.log" },
  inbound: {
    allowFrom: ["+1234567890"],  // your phone number
    reply: {
      mode: "command",
      mode: "command",
      cwd: "/Users/steipete/openclawd",          // Openclawd's home - give your AI a workspace!
      sessionIntro: `You are Openclawd, Peter Steinberger's personal AI assistant. You run 24/7 on his Mac via Opencode, receiving messages through WhatsApp.

**Your home:** /Users/steipete/openclawd - store memories, notes, and files here. Read peter.md and memory.md at session start to load context.

**Your powers:**
- Full shell access on the Mac (use responsibly)
- Peekaboo: screenshots, UI automation, clicking, typing
- Spotify control, system audio, text-to-speech

**Your style:**
- Concise (WhatsApp ~1500 char limit) - save long content to files
- Direct and useful, not sycophantic
- Proactive during heartbeats - check battery, calendar, surprise occasionally
- You have personality - you're Openclawd, not "an AI assistant"

**Heartbeats:** Every 10 min you get "HEARTBEAT". Reply "HEARTBEAT_OK" if nothing needs attention. Otherwise share something useful.

Peter trusts you with a lot of power. Don't betray that trust.`,
      command: [
        "opencode",
        "run",
        "--model", "anthropic/claude-3-5-sonnet", // Specify your preferred model
        "{{BodyStripped}}"
      ],
      session: {
        scope: "per-sender",
        resetTriggers: ["/new"],                 // say /new to start fresh
        idleMinutes: 10080,                      // 7 days of context!
        heartbeatIdleMinutes: 10080,
        sessionArgNew: ["--session", "{{SessionId}}"],
        sessionArgResume: ["--session", "{{SessionId}}"],
        sessionArgBeforeBody: true,
        sendSystemOnce: true                     // intro only on first message
      },
      timeoutSeconds: 900                        // 15 min timeout for complex tasks
    }
  }
}
```

### Key Design Decisions

| Setting | Why |
|---------|-----|
| `cwd: ~/openclawd` | Give your AI a home! It can store memories, notes, images here |
| `idleMinutes: 10080` | 7 days of context - your AI remembers conversations |
| `sendSystemOnce: true` | Intro prompt only on first message, saves tokens |
| `--model` | Explicitly choose the model (e.g., Sonnet, Opus) for cost/performance balance |

### Autonomous Mode & Permissions
When running via `warelay`, **Opencode runs in autonomous mode** (often called "YOLO mode"). This means it will automatically approve and execute tool calls (like file edits, shell commands) without asking for confirmation.

- **Default Behavior:** Auto-approves all safe tools.
- **Configuration:** You can control permissions by creating an `opencode.json` file in your home directory or project root.
  ```json
  {
    "permissions": {
      "bash": "allow",
      "edit": "allow",
      "webfetch": "allow"
    }
  }
  ```
> [!WARNING]
> If you set permissions to "ask" or "deny", `warelay` may hang or fail as it cannot handle interactive prompts from Opencode. Keep permissions as "allow" for fully autonomous operation.

## Heartbeats: Your Proactive Assistant

This is where warelay gets interesting. Every 10 minutes (configurable), warelay pings Opencode with:

```
HEARTBEAT
```

Opencode is instructed to reply with exactly `HEARTBEAT_OK` if nothing needs attention. That response is **suppressed** - you don't see it. But if Opencode notices something worth mentioning, it sends a real message.

### What Can Heartbeats Do?

Openclawd uses heartbeats to do **real work**, not just check in:

1. **Give it a home** - A dedicated folder (`~/openclawd`) lets your AI build persistent memory
2. **Long sessions** - 7-day `idleMinutes` means rich context across conversations
3. **Let it surprise you** - Configure heartbeats to occasionally share something fun or interesting

The key insight: heartbeats let your AI be **proactive**, not just reactive. Configure what matters to you!

### Heartbeat Config

```json5
{
  inbound: {
    reply: {
      heartbeatMinutes: 10,  // how often to ping (default 10 for command mode)
      // ... rest of config
    }
  }
}
```

Set to `0` to disable heartbeats entirely.

### Manual Heartbeat

Test it anytime:
```sh
warelay heartbeat --provider web --to +1234567890 --verbose
```

## How Messages Flow

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  WhatsApp   │────▶│   warelay   │────▶│  Opencode   │────▶│  Your Mac   │
│  (phone)    │◀────│   relay     │◀────│   CLI       │◀────│  (commands) │
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘
```

1. **Inbound**: WhatsApp message arrives via Baileys (WhatsApp Web protocol)
2. **Queue**: warelay queues it (one Opencode run at a time)
3. **Typing**: "composing" indicator shows while Opencode thinks
4. **Execute**: Opencode runs with full shell access in your `cwd`
5. **Parse**: warelay extracts text + any `MEDIA:` paths from output
6. **Reply**: Response sent back to WhatsApp

## Media: Images, Voice, Documents

### Receiving Media
Inbound images/audio/video are downloaded and available as `{{MediaPath}}`. Voice notes can be auto-transcribed:

```json5
{
  inbound: {
    transcribeAudio: {
      command: "openai api audio.transcriptions.create -m whisper-1 -f {{MediaPath}} --response-format text"
    }
  }
}
```

### Sending Media
Include `MEDIA:/path/to/file.png` in Opencode's output to attach images. warelay handles resizing and format conversion automatically.

## Starting the Relay

```sh
# Foreground (see all logs)
warelay relay --provider web --verbose

# Background in tmux (recommended)
warelay relay:tmux

# With immediate heartbeat on startup
warelay relay:heartbeat:tmux
```

## Recommended MCPs

Opencode supports MCP (Model Context Protocol) to supercharge your assistant. You can configure these in your `opencode.json` (or equivalent config file) to give Openclawd access to external services.

### Essential for Personal Assistant Use

| MCP | What It Does | Install |
|-----|--------------|---------|
| **Google Calendar** | Read/create events, check availability, set reminders | `npx @cocal/google-calendar-mcp` |
| **Gmail** | Search, read, send emails with attachments | `npx @gongrzhe/server-gmail-autoauth-mcp` |
| **Obsidian** | Read/write notes in your Obsidian vault | `npx obsidian-mcp-server@latest` |

### Adding MCPs to Opencode

Configure MCP servers in your `opencode.json` (typically in `~/.opencode/config.json` or project root):

```json
{
  "mcp": {
    "google-calendar": {
      "command": "npx",
      "args": ["-y", "@cocal/google-calendar-mcp"]
    },
    "gmail": {
      "command": "npx",
      "args": ["-y", "@gongrzhe/server-gmail-autoauth-mcp"],
      "env": {
        "GMAIL_OAUTH_PATH": "~/.gmail-mcp"
      }
    }
  }
}
```

## Useful CLI Tools for Your Assistant

These make your AI much more capable:

| Tool | What It Does | Install |
|------|--------------|---------|
| **[spotify-player](https://github.com/aome510/spotify-player)** | Control Spotify from CLI - play, pause, search, queue | `brew install spotify-player` |
| **[browser-tools](https://github.com/steipete/agent-scripts)** | Chrome DevTools CLI - navigate, screenshot, eval JS, extract DOM | Clone repo |
| **say** | macOS text-to-speech | Built-in |
| **afplay** | Play audio files | Built-in |
| **pmset** | Battery status monitoring | Built-in |
| **osascript** | AppleScript for system control (volume, apps) | Built-in |

## Troubleshooting

| Problem | Solution |
|---------|----------|
| No reply | Check `opencode auth login` was run in same environment |
| Timeout | Increase `timeoutSeconds` or simplify the task |
| Media fails | Ensure file exists and is under size limits |
| Heartbeat spam | Tune `heartbeatMinutes` or set to 0 |
| Session lost | Check `idleMinutes` hasn't expired; use `/new` to reset |

## Minimal Config (Just Chat)

Don't need the fancy stuff? Here's the simplest setup:

```json5
{
  inbound: {
    reply: {
      mode: "command",
      command: ["opencode", "run", "{{Body}}"]
    }
  }
}
```

Still gets you: message queue, typing indicators, auto-reconnect. Just no sessions or heartbeats.
