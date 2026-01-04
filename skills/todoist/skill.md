---
name: todoist
description: Manage Todoist tasks, projects, labels, and sections via the `todoist` CLI. Use when a user asks Clawdis to add/complete/list tasks, show today's tasks, search tasks, or manage projects.
homepage: https://github.com/buddyh/todoist-cli
metadata: {"clawdis":{"emoji":"✅","requires":{"bins":["todoist"],"env":["TODOIST_API_TOKEN"]},"primaryEnv":"TODOIST_API_TOKEN","install":[{"id":"brew","kind":"brew","formula":"buddyh/tap/todoist","bins":["todoist"],"label":"Install todoist (brew)"},{"id":"go","kind":"go","module":"github.com/buddyh/todoist-cli/cmd/todoist@latest","bins":["todoist"],"label":"Install todoist-cli (go)"}]}}
---

# Todoist CLI

Use `todoist` to manage tasks, projects, labels, and sections via the Todoist REST API.

## Setup

1. Get your API token: https://todoist.com/app/settings/integrations/developer
2. Set environment variable:
   ```bash
   export TODOIST_API_TOKEN="your-token"
   ```
   Or authenticate interactively: `todoist auth`

## JSON Output

All commands support `--json` for machine-readable output with envelope:
```json
{"success":true,"data":[...]}
{"success":false,"error":"..."}
```

## Common Commands

### Tasks

```bash
# Today's tasks (default)
todoist
todoist tasks --today

# All tasks
todoist tasks --all

# Filter tasks
todoist tasks --filter "p1"           # High priority
todoist tasks --filter "overdue"      # Overdue
todoist tasks -p Work                 # By project name

# Add task
todoist add "Buy groceries"
todoist add "Call mom" -d tomorrow
todoist add "Urgent task" -P 1 -d "today 5pm"
todoist add "Work task" -p Work -l urgent

# Complete task
todoist complete <task-id>
todoist done <task-id>

# View task details
todoist view <task-id>

# Update task
todoist update <task-id> --due "next monday"
todoist update <task-id> -P 2

# Delete task (with confirmation)
todoist delete <task-id>
todoist delete <task-id> --force

# Search
todoist search "meeting"
```

### Projects

```bash
todoist projects                      # List all
todoist projects --json               # JSON output
todoist projects add "New Project"    # Create project
```

### Labels

```bash
todoist labels                        # List all
todoist labels add urgent             # Create label
```

### Sections

```bash
todoist sections -p Work              # List sections in project
todoist sections add "In Progress" -p Work
```

### Comments

```bash
todoist comment <task-id>             # View comments
todoist comment <task-id> "Note"      # Add comment
```

### Completed Tasks

```bash
todoist completed                     # Recently completed
todoist completed --since 2024-01-01  # Since date
todoist completed -p Work             # By project
```

## Priority Mapping

| CLI Flag | Todoist |
|----------|---------|
| `-P 1`   | p1 (highest, red) |
| `-P 2`   | p2 (orange) |
| `-P 3`   | p3 (blue) |
| `-P 4`   | p4 (lowest) |

## Examples

Add task to specific project with due date and priority:
```bash
todoist add "Review PR" -p Work -d "tomorrow 2pm" -P 2 -l code-review
```

List today's high priority tasks as JSON:
```bash
todoist tasks --filter "today & p1" --json
```

Quick capture from stdin:
```bash
echo "Quick idea" | xargs todoist add
```

## Notes

- Cross-platform (macOS, Linux, Windows)
- Single binary, no runtime dependencies
- `--json` output follows `{success, data, error}` envelope pattern
