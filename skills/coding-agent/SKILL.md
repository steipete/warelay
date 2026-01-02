---
name: coding-agent
description: Run Claude Code, Codex CLI, or OpenCode via tmux for resilient coding sessions.
metadata: {"clawdis":{"emoji":"🧩","requires":{"bins":["tmux"],"anyBins":["claude","codex","opencode"]}}}
---

# Coding Agent (tmux-first)

Use **tmux** for all coding-agent CLIs. Keep sessions resumable and logs visible.

## Quick preflight

```bash
command -v claude codex opencode tmux
```

If none of `claude`, `codex`, `opencode` exist, stop and ask to install.

## tmux baseline

```bash
# Create or attach
tmux new -A -s coding-agent

# Split panes
tmux split-window -h
tmux split-window -v

# Leave running, detach
tmux detach
```

## Claude Code

Interactive (preferred in tmux):
- `claude` — start session
- `claude -c` — continue most recent
- `claude -r ""` — picker
- `claude -r <session_id>` — resume specific

## Codex CLI

One-shot (safe in tmux):
- `codex exec "Write a Python function that ..."`
- `codex exec --model gpt-4o "Complex task"`
- `codex exec --model o3 "Reasoning-heavy task"`

Interactive:
- `codex "Your prompt"`
- `codex resume`
- `codex resume --last`
- `codex resume --session <id>`

Apply changes:
- `codex apply`

## OpenCode

One-shot:
- `opencode run "Write a Python function that ..."`
- `opencode run -m anthropic/claude-sonnet-4-5 "Complex task"`
- `opencode run -m openai/gpt-5.2 "Coding task"`
- `opencode run -m google/gemini-2.5-pro "Research task"`

Interactive:
- `opencode`
- `opencode -c`
- `opencode -s <session-id>`

Session management:
- `opencode session list`
- `opencode export [sessionID]`
- `opencode import <file>`

## Notes

- Prefer **tmux** even for one-shot runs; keep history + recovery.
- For auth, run the tool’s login flow in tmux (`claude`, `codex login`, `opencode auth`).
