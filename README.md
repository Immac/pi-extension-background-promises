# bg-promises

![TypeScript](https://img.shields.io/badge/TypeScript-ES2022+-3178c9?style=flat-square&logo=typescript)
![MIT License](https://img.shields.io/badge/license-MIT-yellow?style=flat-square)
![Pi Extension](https://img.shields.io/badge/pi--extension-c084fc?style=flat-square)

Non-blocking background promises for pi agent — **fire tasks, keep working, results auto-deliver.**

---

## ✨ Features

- 🔔 **Auto-delivery** — results arrive as `[System]` notifications, no polling
- 🎯 **Intent mechanism** — specify what to do after completion; agent executes automatically
- ⛓️ **Chaining** — attach follow-up steps with `promise-then` at any time
- 🚫 **Dedup & Replace** — avoid duplicate work or cancel-and-restart
- 📈 **Progress tracking** — live block progress bars in TUI footer
- 🔄 **Session isolation** — promises don't cross between pi sessions
- 💾 **Persistence** — survives pi reload via scoped state files

---

## 🛠️ Tools

| Tool | Description |
|------|-------------|
| `promise-create` | Start a background task. Returns immediately. Supports `intent`, `subject`, `dedup`, `replace`, and `then` chaining. |
| `promise-then` | Chain a command/download after any existing promise. Supports `condition`: `always`, `on-success`, `on-failure`. |
| `promise-graph` | Inspect chain relationships — tree view for a specific promise or all chains. |
| `promise-rechain` | Re-attach a cancelled/failed promise to a different parent chain. |
| `promise-status` | Check status without blocking. Returns last known result. |
| `promises-list` | List all tracked promises as a chain tree. |
| `promise-cancel` | Cancel a pending or running promise. |

### Commands

| Command | Action |
|---------|--------|
| `/promise` | Toggle expanded status bar |
| `/promise 1` | Show live tmux output for root promise #1 |
| `/promise <name>` | Show live output by promise name |
| `/promise stop` | Close the live output view |

### Shortcuts

| Key | Action |
|-----|--------|
| `F4` | Toggle expanded promise status bar |
| `Ctrl+Shift+B` | Toggle expanded promise status bar |

---

## 🚀 Quick Start

### Installation

```bash
pi install /path/to/bg-promises
```

### Basic Usage

```
User: "Run tests and review the code while they run"

Agent:
  → promise-create(command="npm test", name="tests", intent="report results")
  → read(path="./src/app.ts")                    ← work on different task
  → [reviews code]

🔔 [System] Promise completed: run tests
Intent: report results

Agent: [executes intent automatically]
```

### With Intent

```
promise-create(
  command="python train.py --epochs 100",
  subject="train model",
  intent="run evaluation and save metrics"
)
```

When the promise completes, the agent automatically runs evaluation — no user interaction needed.

---

## 📦 Usage Examples

### Parallel Work

```
promise-create(command="npm test", name="test-suite")
read(path="./src/routes.ts")              ← work while tests run
edit(path="./src/routes.ts", ...)         ← more work

🔔 Promise completed → agent continues naturally
```

### Multi-Step Pipeline

```
promise-create(command="python preprocess.py", name="pipeline")
promise-then(promiseId="promise-abc", command="python train.py", condition="on-success")
promise-then(promiseId="promise-abc", command="python eval.py", condition="on-success")
promise-then(promiseId="promise-abc", command="curl https://alerts/fail", condition="on-failure")
```

### Dedup & Replace

```
// Avoid duplicate work
promise-create(command="npm test", subject="run tests", dedup=true)

// Cancel and restart when code changes
promise-create(command="npm test", subject="run tests", replace=true)
```

### Progress Tracking

```bash
for i in $(seq 0 100); do
  echo "PROMISE_PROGRESS:$i"
  heavy_step $i
done
```

TUI shows: `[F4] ①→$[████] 85% "Processing..."`

---

## 📊 Status Bar

**Compact** (footer):
```
①→$✓→$○ | ②→$●  ●1 ✓1
```

**Expanded** (`F4`):
```
 ⚡ Background Promises

 ✓ $ pipeline
   └─→ ✓ $ train (on-success)
        └─→ ○ $ eval (on-success)

Press F4 to collapse
```

---

## 🔔 System Notifications

Promises complete with `[System]` messages — clean for the LLM, icons for the user:

```
// LLM sees:
[System] Promise completed: train model
Intent: run evaluation

// User sees in TUI:
🔔 [System] Promise completed: train model
Intent: run evaluation
```

Full results are injected into the system prompt via `before_agent_start`.

---

## 🔄 Session Isolation

Promises are isolated per pi session:

- Each promise stores `instanceId` of its creating session
- State files scoped: `~/.pi/agent/promise-state-{sessionKey}.json`
- Tmux sessions namespaced: `promise-{parentSession}-{instanceId}-{promiseId}`
- Orphan cleanup on startup removes stale sessions from other instances

---

## 🧪 Development

```bash
npm run validate    # TypeScript check
npm test           # Integration tests
```

---

## 📚 Resources

- [Skill Documentation](skills/bg-promises/SKILL.md)
- [Architecture](ARCHITECTURE.md)
- [Examples](skills/bg-promises/examples/)

---

## 📄 License

MIT
