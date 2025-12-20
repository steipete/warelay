---
summary: "Running Clawdis under Nix (config, state, and packaging expectations)"
read_when:
  - Building Clawdis with Nix
  - Debugging Nix-mode behavior
---
# Nix mode

Clawdis supports a **Nix mode** that makes configuration deterministic and disables auto-install flows.
Enable it by exporting:

```
CLAWDIS_NIX_MODE=1
```

## Config + state paths

Clawdis reads JSON5 config from `CLAWDIS_CONFIG_PATH` and stores mutable data in `CLAWDIS_STATE_DIR`.

- `CLAWDIS_STATE_DIR` (default: `~/.clawdis`)
- `CLAWDIS_CONFIG_PATH` (default: `$CLAWDIS_STATE_DIR/clawdis.json`)

When running under Nix, set these explicitly to Nix-managed locations so runtime state and config
stay out of the immutable store.

## Runtime behavior in Nix mode

- Auto-install and self-mutation flows should be disabled.
- Missing dependencies should surface Nix-specific remediation messages.
- UI surfaces a read-only Nix mode banner when present.

## Packaging note (macOS)

The macOS packaging flow expects a stable Info.plist template at:

```
apps/macos/Sources/Clawdis/Resources/Info.plist
```

`scripts/package-mac-app.sh` copies this template into the app bundle and patches dynamic fields
(bundle ID, version/build, Git SHA, Sparkle keys). This keeps the plist deterministic for SwiftPM
packaging and Nix builds (which do not rely on a full Xcode toolchain).
