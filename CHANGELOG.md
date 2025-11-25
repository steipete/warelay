# Changelog

## 0.1.3 — 2025-11-25

### Features
- Added `cwd` option to command reply config for setting the working directory where commands execute. Essential for Claude Code to have proper project context.
- Added configurable file-based logging (default `/tmp/warelay/warelay.log`) with log level set via `logging.level` in `~/.warelay/warelay.json`; verbose still forces debug.

### Developer notes
- Command auto-replies now pass `{ timeoutMs, cwd }` into the command runner; custom runners/tests that stub `runCommandWithTimeout` should accept the options object as well as the legacy numeric timeout.

## 0.1.2 — 2025-11-25

### CI/build fix
- Fixed commander help configuration (`subcommandTerm`) so TypeScript builds pass in CI.

## 0.1.1 — 2025-11-25

### CLI polish
- Added a proper executable shim so `npx warelay@0.1.x --help` runs the CLI directly.
- Help/version banner now uses the README tagline with color, and the help footer includes colored examples with short explanations.
- `send` and `status` gained a `--verbose` flag for consistent noisy output when debugging.
- Lowercased branding in docs/UA; web provider UA is `warelay/cli/0.1.1`.


## 0.1.0 — 2025-11-25

### CLI & Providers
- Bundles a single `warelay` CLI with commands for `send`, `relay`, `status`, `webhook`, `login`, and tmux helpers `relay:tmux` / `relay:tmux:attach` (see `src/cli/program.ts`); `webhook` accepts `--ingress tailscale|none`.
- Supports two messaging backends: **Twilio** (default) and **personal WhatsApp Web**; `relay --provider auto` selects Web when a cached login exists, otherwise falls back to Twilio polling (`provider-web.ts`, `cli/program.ts`).
- `send` can target either provider, optionally wait for delivery status (Twilio only), output JSON, dry-run payloads, and attach media (`commands/send.ts`).
- `status` merges inbound + outbound Twilio traffic with formatted lines or JSON output (`commands/status.ts`, `twilio/messages.ts`).

### Webhook, Funnel & Port Management
- `webhook` starts an Express server for inbound Twilio callbacks, logs requests, and optionally auto-replies with static text or config-driven replies (`twilio/webhook.ts`, `commands/webhook.ts`).
- `webhook --ingress tailscale` automates end-to-end webhook setup: ensures required binaries, enables Tailscale Funnel, starts the webhook on the chosen port/path, discovers the WhatsApp sender SID, and updates Twilio webhook URLs with multiple fallbacks (`commands/up.ts`, `infra/tailscale.ts`, `twilio/update-webhook.ts`, `twilio/senders.ts`).
- Guardrails detect busy ports with helpful diagnostics and aborts when conflicts are found (`infra/ports.ts`).

### Auto-Reply Engine
- Configurable via `~/.warelay/warelay.json` (JSON5) with allowlist support, text or command-driven replies, templating (`{{Body}}`, `{{From}}`, `{{MediaPath}}`, etc.), optional body prefixes, and per-sender or global conversation sessions with `/new` resets and idle expiry (`auto-reply/reply.ts`, `config/config.ts`, `config/sessions.ts`, `auto-reply/templating.ts`).
- Command replies run through a process-wide FIFO queue to avoid concurrent executions across webhook, poller, and web listener flows (`process/command-queue.ts`); verbose mode surfaces wait times.
- Claude CLI integration auto-injects identity, output-format flags, session args, and parses JSON output while preserving metadata (`auto-reply/claude.ts`, `auto-reply/reply.ts`).
- Typing indicators fire before replies for Twilio, and Web provider sends “composing/available” presence when possible (`twilio/typing.ts`, `provider-web.ts`).

### Media Pipeline
- `send --media` works on both providers: Web accepts local paths or URLs; Twilio requires HTTPS and transparently hosts local files (≤5 MB) via the Funnel/webhook media endpoint, auto-spawning a short-lived media server when `--serve-media` is requested (`commands/send.ts`, `media/host.ts`, `media/server.ts`).
- Auto-replies may include `mediaUrl` from config or command output (`MEDIA:` token extraction) and will host local media when needed before sending (`auto-reply/reply.ts`, `media/parse.ts`, `media/host.ts`).
- Inbound media from Twilio or Web is downloaded to `~/.warelay/media` with TTL cleanup and passed to commands via `MediaPath`/`MediaType` for richer prompts (`twilio/webhook.ts`, `provider-web.ts`, `media/store.ts`).

### Relay & Monitoring
- `relay` polls Twilio on an interval with exponential-backoff resilience, auto-replying to inbound messages, or listens live via WhatsApp Web with automatic read receipts and presence updates (`cli/program.ts`, `twilio/monitor.ts`, `provider-web.ts`).
- `send` + `waitForFinalStatus` polls Twilio until a terminal delivery state (delivered/read) or timeout, with clear failure surfaces (`twilio/send.ts`).

### Developer & Ops Ergonomics
- `relay:tmux` helper restarts/attaches to a dedicated `warelay-relay` tmux session for long-running relays (`cli/relay_tmux.ts`).
- Environment validation enforces Twilio credentials early and supports either auth token or API key/secret pairs (`env.ts`).
- Shared logging utilities, binary checks, and runtime abstractions keep CLI output consistent (`globals.ts`, `logger.ts`, `infra/binaries.ts`).
