# bg-promises

[![TypeScript](https://img.shields.io/badge/TypeScript-ES2022+-3178c9?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow)](https://opensource.org/licenses/MIT)
[![Pi Extension](https://img.shields.io/badge/Pi%20Extension-Tool-c084fc?logo=pi)](https://pi.dev)

Non-blocking background promises for pi agent — **fire off long tasks and keep working.** Results arrive automatically as `[System]` notifications, no polling required.

The core philosophy: **whenever you can work on something else while a task runs, use a promise.**

---

## How It Works

1. **`promise-create`** starts a command or download in the background, returns a promise ID immediately
2. **Keep working** — edit files, read code, answer questions, start more promises
3. **Auto-delivery** — when each task completes, the result arrives as a `[System]` notification with full context in the system prompt
4. **Intent** — specify what to do after completion; the agent executes it automatically

```
User: "Download the dataset and review the training script while it runs"

Agent:
  → promise-create(download="https://...", path="./data.csv", name="download-data", intent="run preprocessing")
  → "Started download: promise-123"
  → read(path="./train.py")
  → [reviews script, suggests improvements]

[System] Promise completed: Download dataset        ← auto-delivery, no polling
Intent: run preprocessing

Agent: [executes intent automatically]               ← proactive, doesn't ask user
```

---

## Tools

| Tool | Description |
|------|-------------|
| `promise-create` | Start a background task (command or download). Returns immediately. Supports `intent` (what to do after), `subject` (semantic label), `dedup`/`replace`, and `then` + `thenCondition` for chaining. |
| `promise-then` | Chain a command or download **after** any existing promise. Multiple calls create a sequence. Supports `condition`: `always`, `on-success`, `on-failure`. |
| `promise-graph` | Inspect chain relationships — tree view for a specific promise or all chains. |
| `promise-rechain` | Re-attach a cancelled/failed promise's command to a different parent chain. |
| `promise-status` | Check status without blocking. Returns last known result. |
| `promises-list` | List all tracked promises as a chain tree showing parent-child relationships. |
| `promise-cancel` | Cancel a pending or running promise (kills child process). |

---

## 🧠 When to Use Promises — Decision Guide

| Situation | Use a promise? |
|-----------|---------------|
| Running tests, linting, formatting | ✅ Yes — work on other things while they run |
| Downloading files, models, data | ✅ Yes — read docs, review code meanwhile |
| Data processing, ETL, training | ✅ Yes — chain eval/report with `promise-then` |
| Installing packages, building | ✅ Yes — start, then continue reviewing |
| Reading a file | ❌ No — too fast, just read directly |
| Quick git operations | ❌ No — just run them inline |

**Default to using promises.** If a task takes more than a few seconds, fire it and move on.

---

## Intent — Proactive Auto-Execution

When creating a promise, specify an **intent** — what to do after it completes. The agent executes the intent automatically without asking the user.

```
promise-create(
  command="npm test",
  subject="run test suite",
  intent="fix any failing tests, then commit"
)
```

**How it works:**

1. Promise completes → `[System] Promise completed: run test suite\nIntent: fix any failing tests, then commit`
2. Full result injected into system prompt via `before_agent_start`
3. Agent sees result + intent in context
4. Agent executes intent autonomously

**Without intent:** Agent receives notification, might ask "what should I do?"
**With intent:** Agent knows exactly what to do, acts proactively.

---

## 🔔 System Notifications

Promise completions arrive as `[System]` messages — not user messages. The agent understands these are automated notifications and acts on them autonomously.

**Completed:**
```
[System] Promise completed: Document the project
Intent: run tests and commit
```

**Failed:**
```
[System] Promise failed: Build project
Error: Command exited with code 1
Intent: fix build errors
```

**Cancelled:**
```
[System] Promise cancelled: Download dataset
```

The TUI adds visual icons (🔔 ❌ ⏱) via a custom message renderer — the LLM sees clean `[System]` messages without emoji noise.

**Full results** are injected into the system prompt, not the user message:
```
[Background Task Results]
- "Document the project" (completed): {"files_changed": ["AGENTS.md", "docs/API.md"]}
Intent: run tests and commit
```

---

## ⛓️ Chaining (`promise-then`)

Attach follow-up steps to any existing promise. Multiple calls create a sequence.

```
promise-create(command="python preprocess.py", name="pipeline", intent="train model")
→ promiseId: "promise-abc"

# Chain more steps:
promise-then(promiseId="promise-abc", command="python train.py")
promise-then(promiseId="promise-abc", command="python eval.py")
```

Each call appends to the **end** of the chain. Results flow through: `preprocess → train → eval`.

**Conditional chains:**
```
promise-then(promiseId="promise-abc", command="python eval.py", condition="on-success")
promise-then(promiseId="promise-abc", command="curl https://alerts/fail", condition="on-failure")
```

---

## 🚫 Dedup & Replace

**Dedup** — avoid duplicate work:
```
promise-create(command="npm test", subject="run tests", dedup=true)
→ Returns existing promise ID if one with same subject is running
```

**Replace** — cancel & restart when work changes:
```
promise-create(command="npm test", subject="run tests", replace=true)
→ Cancels existing promise, creates fresh one
```

---

## 📈 Progress Tracking

Commands can report live progress by printing `PROMISE_PROGRESS:N` (0-100) to stdout:

```bash
for i in $(seq 0 100); do
  echo "PROMISE_PROGRESS:$i"
  heavy_step $i
done
```

The TUI footer shows a live block progress bar:
```
[F4] ①→$[████] 85% "Processing step 85..."  ✓3
```

---

## 🔄 Session Isolation

Promises are isolated per pi session. Multiple pi instances running simultaneously don't interfere with each other.

**How it works:**
- Each promise stores the `instanceId` of the pi session that created it
- State files are scoped: `~/.pi/agent/promise-state-{sessionKey}.json`
- Tmux sessions are namespaced: `promise-{parentSession}-{instanceId}-{promiseId}`
- On startup, orphan cleanup removes stale tmux sessions from other instances

---

## 📊 Status Bar (TUI)

**Compact view** — always visible in footer:
```
①→$✓→$○ | ②→$●  ●1 ✓1
```

**Expanded view** — press `F4`:
```
 ⚡ Background Promises

 ✓ $ full-pipeline
   └─→ ✓ $ step2 (on-success)
        └─→ ○ $ step3 (on-success)

Press F4 to collapse
```

**Live output** — `/promise 1` shows tmux output for a specific promise.

---

## 🔄 Persistence — Survives Reload

Promises survive pi reload. On startup:
1. Loads promises from scoped state file
2. Re-discovers tmux sessions by matching session names
3. Reconnects completion polling and progress tracking
4. Cleans up orphaned tmux sessions from other instances

---

## `/promise` Command

| Command | Action |
|---------|--------|
| `/promise` | Toggle expanded status bar |
| `/promise 1` | Show live tmux output for root promise #1 |
| `/promise <name>` | Show live output by promise name |
| `/promise stop` | Close the live output view |

---

## Installation

```bash
npm run validate
npm test
pi install /home/immac/Repositories/ai_generation/tools/pi-extensions/bg-promises
```

## Development

```bash
npm run validate    # TypeScript check
npm test           # Integration tests
```

---

## License

MIT
