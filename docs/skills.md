---
summary: "Skills: managed vs workspace, gating rules, and config/env wiring"
read_when:
  - Adding or modifying skills
  - Changing skill gating or load rules
---
<!-- {% raw %} -->
# Skills (Clawdis)

Clawdis uses **AgentSkills-compatible** skill folders to teach the agent how to use tools. Each skill is a directory containing a `SKILL.md` with YAML frontmatter and instructions. Clawdis loads **bundled skills** plus optional local overrides, and filters them at load time based on environment, config, and binary presence.

## Locations and precedence

Skills are loaded from **three** places:

1) **Bundled skills**: shipped with the install (npm package or Clawdis.app)
2) **Managed/local skills**: `~/.clawdis/skills`
3) **Workspace skills**: `<workspace>/skills`

If a skill name conflicts, precedence is:

`<workspace>/skills` (highest) → `~/.clawdis/skills` → bundled skills (lowest)

Additionally, you can configure extra skill folders (lowest precedence) via `skillsLoad.extraDirs` in `~/.clawdis/clawdis.json`.

## Format (AgentSkills + Pi-compatible)

`SKILL.md` must include at least:

```markdown
---
name: nano-banana-pro
description: Generate or edit images via Gemini 3 Pro Image
---
```

Notes:
- We follow the AgentSkills spec for layout/intent.
- The parser used by the embedded agent supports **single-line** frontmatter keys only.
- `metadata` should be a **single-line JSON object**.
- Use `{baseDir}` in instructions to reference the skill folder path.
- Optional frontmatter keys:
  - `homepage` — URL surfaced as “Website” in the macOS Skills UI (also supported via `metadata.clawdis.homepage`).

## Gating (load-time filters)

Clawdis **filters skills at load time** using `metadata` (single-line JSON):

```markdown
---
name: nano-banana-pro
description: Generate or edit images via Gemini 3 Pro Image
metadata: {"clawdis":{"requires":{"bins":["uv"],"env":["GEMINI_API_KEY"],"config":["browser.enabled"]},"primaryEnv":"GEMINI_API_KEY"}}
---
```

Fields under `metadata.clawdis`:
- `always: true` — always include the skill (skip other gates).
- `emoji` — optional emoji used by the macOS Skills UI.
- `homepage` — optional URL shown as “Website” in the macOS Skills UI.
- `requires.bins` — list; each must exist on `PATH`.
- `requires.anyBins` — list; at least one must exist on `PATH`.
- `requires.env` — list; env var must exist **or** be provided in config.
- `requires.config` — list of `clawdis.json` paths that must be truthy.
- `primaryEnv` — env var name associated with `skills.<name>.apiKey`.
- `install` — optional array of installer specs used by the macOS Skills UI (brew/node/go/uv).

Installer example:

```markdown
---
name: gemini
description: Use Gemini CLI for coding assistance and Google search lookups.
metadata: {"clawdis":{"emoji":"♊️","requires":{"bins":["gemini"]},"install":[{"id":"brew","kind":"brew","formula":"gemini-cli","bins":["gemini"],"label":"Install Gemini CLI (brew)"}]}}
---
```

Notes:
- If multiple installers are listed, the gateway picks a **single** preferred option (brew when available, otherwise node).
- Node installs honor `skillsInstall.nodeManager` in `clawdis.json` (default: npm; options: npm/pnpm/yarn).

If no `metadata.clawdis` is present, the skill is always eligible (unless disabled in config).

## Config overrides (`~/.clawdis/clawdis.json`)

Bundled/managed skills can be toggled and supplied with env values:

```json5
{
  skills: {
    "nano-banana-pro": {
      enabled: true,
      apiKey: "GEMINI_KEY_HERE",
      env: {
        GEMINI_API_KEY: "GEMINI_KEY_HERE"
      }
    },
    peekaboo: { enabled: true },
    sag: { enabled: false }
  }
}
```

Note: if the skill name contains hyphens, quote the key (JSON5 allows quoted keys).

Config keys match the **skill name**. We don’t require a custom `skillKey`.

Rules:
- `enabled: false` disables the skill even if it’s bundled/installed.
- `env`: injected **only if** the variable isn’t already set in the process.
- `apiKey`: convenience for skills that declare `metadata.clawdis.primaryEnv`.

## Environment injection (per agent run)

When an agent run starts, Clawdis:
1) Reads skill metadata.
2) Applies any `skills.<key>.env` or `skills.<key>.apiKey` to `process.env`.
3) Builds the system prompt with **eligible** skills.
4) Restores the original environment after the run ends.

This is **scoped to the agent run**, not a global shell environment.

## Session snapshot (performance)

Clawdis snapshots the eligible skills **when a session starts** and reuses that list for subsequent turns in the same session. Changes to skills or config take effect on the next new session.

## Managed skills lifecycle

Clawdis ships a baseline set of skills as **bundled skills** as part of the install (npm package or Clawdis.app). `~/.clawdis/skills` exists for local overrides (for example, pinning/patching a skill without changing the bundled copy). Workspace skills are user-owned and override both on name conflicts.

---
<!-- {% endraw %} -->
