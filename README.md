# bg-promises

[![TypeScript](https://img.shields.io/badge/TypeScript-ES2022+-3178c9?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow)](https://opensource.org/licenses/MIT)
[![Pi Extension](https://img.shields.io/badge/Pi%20Extension-Tool-c084fc?logo=pi)](https://pi.dev)

Non-blocking background promises for pi agent — fire off long tasks and keep working. Results arrive automatically as messages, no polling required.

## How It Works

1. **`promise-create`** starts a command or download in the background and returns a promise ID immediately
2. **Keep working** — the agent continues answering questions, editing files, running other tools
3. **Auto-delivery** — when the task completes, `pi.sendMessage()` delivers the result as a message in the conversation
4. **Pick it up** — the agent sees the completed result and continues

```
Agent: "I'll run the test suite while I review the new feature code."
  → promise-create(command="npm test", name="test-suite")
  → "Started command: promise-456"

Agent: "Now let me check the new feature..."
  → read(path="./src/new-feature.ts")
  → [works on other things]

🔔 Promise "test-suite" completed!     ← auto-delivered
  Result: { output: "PASS 42/42 tests" }

Agent: "All 42 tests pass. Let me review the new feature."
```

## Tools

| Tool | Description |
|------|-------------|
| `promise-create` | Start async task (download or command). Returns immediately. Result auto-delivers when done. Supports chaining via `then`. |
| `promise-await` | Explicit blocking wait with smart download heuristics (stall detection) |
| `promise-status` | Non-blocking status check, includes last result |
| `promises-list` | List all tracked promises |
| `promise-cancel` | Cancel a pending/running promise (kills child process) |

## Features

### 🔔 Auto-Delivery on Completion

When a background promise completes, the agent is automatically notified:

```
🔔 Promise "my-task" completed!
• Type: command
• Result: { "output": "42 rows processed" }
```

Failed promises also notify:

```
❌ Promise "my-task" failed!
• Type: download
• Error: curl exited with code 22
```

Messages use `customType: "promise-completion"` and queue as `followUp` — they never interrupt the agent mid-turn.

### Smart Await Heuristics

`promise-await` uses intelligent detection depending on promise type:
- **Downloads**: File-growth based stall detection — polls file size, times out only after no progress for N seconds, considers done after a grace period of no growth
- **Commands**: Simple await on the child process exit, returns stdout/stderr

### Status Bar (TUI)

The extension adds a live promise status bar to the pi TUI footer that tracks all background promises.

**Compact view** (always visible in footer): Colored counts showing running (`●`), pending (`○`), completed (`✓`), and failed (`✗`) promises, plus the name of the currently running task.

**Expanded view** (toggle with `ctrl+shift+b`): A detailed widget below the editor listing every promise with status icon, type indicator (`↓` download / `$` command), name, and running result or error info.

```
 ⚡ Background Promises

 ● $ train-model   Running: python train.py --epochs 50
 ✓ ↓ data.csv      {"path": "./data.csv", "size": 12345}
 ✗ $ preprocess    Command exited with code 1

 Press ctrl+shift+b to collapse
```

The status bar updates automatically when promises are created, completed, fail, or cancelled.

### Chained Commands

Use `then` to chain a command after another. Both steps auto-deliver results.

```
promise-create(
  command="python train.py --epochs 10",
  then="python eval.py --checkpoint ./checkpoints/latest.pt"
)
```

### Process Cleanup

- Cancel kills the child process with `SIGTERM`
- No orphaned processes when pi exits or cancels

## Installation

```bash
# Validate and test first
npm run validate
npm test

# Install into pi
pi install /home/immac/Repositories/ai_generation/tools/pi-extensions/bg-promises
```

## Development

```bash
# Validate TypeScript
npm run validate

# Run integration tests
npm test
```

## Repository

- GitHub: [github.com/Immac/pi-extension-background-promises](https://github.com/Immac/pi-extension-background-promises)

## License

MIT
