# Architecture

## Overview

bg-promises is a non-blocking background task system for pi agent. It allows the agent to fire long-running tasks and continue working while results auto-deliver.

## Core Concepts

### Promise Lifecycle

```
create → pending → running → completed/failed/cancelled
                           ↓
                        notify → intent execution
```

### Key Design Decisions

1. **`[System]` notifications** — Promise completions use `[System]` prefix to distinguish from user messages. The LLM understands these are automated.

2. **Intent mechanism** — Promises carry an `intent` field specifying what to do after completion. The agent executes it automatically.

3. **System prompt injection** — Full results are injected via `before_agent_start`, not in the user message. This keeps the LLM context clean.

4. **Session isolation** — Each pi session gets its own state file and tmux namespace. No cross-session interference.

## Components

### Promise Manager (Singleton)

```typescript
const promises = new Map<string, BackgroundPromise>();
```

In-memory store of all promises. Persisted to disk on state changes.

### Tmux Runner

Commands run in detached tmux sessions for reliability:
- Survives pi reload
- Output captured to `/tmp/promise-{id}.out`
- Progress parsed from stdout markers

### Direct Runner

Fallback when tmux unavailable:
- Uses Node.js `spawn()`
- Output accumulated in memory
- Less reliable but works everywhere

### State Persistence

Scoped state files survive reload:
- `~/.pi/agent/promise-state-{sessionKey}.json`
- Only running/pending promises saved
- Loaded on `session_start`, deleted after load

### Notification System

```
promise completes
  → _pendingResults.push(result)
  → sendMessage("[System] Promise completed: ...")
  → before_agent_start injects results into system prompt
  → LLM executes intent
```

### Custom TUI Renderer

Adds visual icons (🔔 ❌ ⏱) for the user while keeping `[System]` clean for the LLM.

## Data Flow

```
LLM calls promise-create
  → promise stored in Map
  → command spawned (tmux or direct)
  → status bar updated
  → returns promiseId immediately

LLM continues working...
  → other tools, edits, reads

Command completes
  → tmux polling detects completion
  → result stored in _pendingResults
  → sendMessage triggers turn
  → before_agent_start injects result
  → LLM sees: [System] + intent
  → LLM executes intent
```

## Session Isolation

### Problem
Multiple pi sessions sharing a global state file caused promises to cross sessions.

### Solution
1. **instanceId** — Each promise stores the creating session's ID
2. **Scoped state files** — `promise-state-{sessionKey}.json`
3. **Tmux namespacing** — `promise-{parentSession}-{instanceId}-{promiseId}`
4. **Orphan cleanup** — On startup, kill stale sessions from other instances

## File Structure

```
bg-promises/
├── src/
│   └── extensions/
│       └── downloads-wisely/
│           └── bg-promises.ts    # Main extension (2700 lines)
├── test/
│   └── auto-injection.test.ts   # Integration tests
├── skills/
│   └── bg-promises/
│       ├── SKILL.md             # Agent-facing instructions
│       └── examples/            # Usage patterns
├── package.json
├── tsconfig.json
├── README.md
└── ARCHITECTURE.md              # This file
```

## Key Functions

| Function | Purpose |
|----------|---------|
| `runCommand()` | Execute command via tmux or direct |
| `runDownload()` | Fetch URL with progress tracking |
| `runChainedPromise()` | Execute next step in chain |
| `notifyCompletion()` | Send `[System]` notification |
| `_resumePromiseTracking()` | Reconnect tmux after reload |
| `_killOrphanedTmuxSessions()` | Clean stale sessions |
| `_updateStatusBar()` | Render TUI status |

## Anti-Patterns Prevented

1. **No `promise-block-until-complete`** — Agent must never block on promises
2. **No polling** — Results auto-deliver via `[System]` messages
3. **No session crossing** — Scoped state and tmux namespacing
4. **No orphan sessions** — Cleanup on startup and completion
