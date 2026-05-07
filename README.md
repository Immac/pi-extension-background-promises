# bg-promises

[![TypeScript](https://img.shields.io/badge/TypeScript-ES2022+-3178c9?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow)](https://opensource.org/licenses/MIT)
[![Pi Extension](https://img.shields.io/badge/Pi%20Extension-Tool-c084fc?logo=pi)](https://pi.dev)

Non-blocking background promises for pi agent — **fire off long tasks and keep working.** Results arrive automatically as messages, no polling required.

The core philosophy: **whenever you can work on something else while a task runs, use a promise.**

---

## How It Works

1. **`promise-create`** starts a command or download in the background, returns a promise ID immediately
2. **Keep working** — edit files, read code, answer questions, start more promises
3. **Auto-delivery** — when each task completes, the result arrives as a conversation message
4. **Chain** — attach follow-up steps with `promise-then` at any point, even after the root completes

```
User: "Download the dataset and review the training script while it runs"

Agent:
  → promise-create(download="https://...", path="./data.csv", name="download-data")
  → "Started download: promise-123"
  → read(path="./train.py")
  → [reviews script, suggests improvements]

🔔 Promise "download-data" completed!    ← keeps working, no polling
  Result: { path: "./data.csv", size: 1234567 }

Agent: "Download complete. Here's my review of train.py..."
```

---

## Tools

| Tool | Description |
|------|-------------|
| `promise-create` | Start a background task (command or download). Returns immediately. Result auto-delivers. Accepts `then` + `thenCondition` for initial chaining. |
| `promise-then` | Chain a command or download **after** any existing promise. Multiple calls create a sequence. Supports `condition`: `always` (default), `on-success`, `on-failure`. |
| `promise-await` | Block until a promise completes (rarely needed — results auto-deliver). Has smart download stall detection. |
| `promise-status` | Check status without blocking. Returns last known result. |
| `promises-list` | List all tracked promises and their current status. |
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
| You need the result to continue | ⚠️ Use `promise-then` to chain instead of `promise-await` |
| You must block (interactive auth, user input) | ⚠️ Use `promise-await` as last resort |

**Default to using promises.** If a task takes more than a few seconds, fire it and move on. The auto-delivery pattern means you never forget about it — the result will arrive when ready.

---

## Features

### 🔔 Auto-Delivery on Completion

All promises (root and chained) auto-deliver results:

```
🔔 Promise "train-model" completed!
• Type: command
• Status: completed
• Result: { "output": "Epoch 50/50 — loss: 0.023" }
You can use promise-await("promise-xxx") for full structured details.
```

Failed promises also notify — you can chain a fallback with `condition="on-failure"`.

### ⛓️ Chaining After the Fact (`promise-then`)

The signature feature: **attach a follow-up to any existing promise at any time.**

```
promise-create(command="python preprocess.py", name="pipeline")
→ promiseId: "promise-abc"

# Later — chain more steps without blocking:
promise-then(promiseId="promise-abc", command="python train.py")
promise-then(promiseId="promise-abc", command="python eval.py")
```

Each call appends to the **end** of the chain. The result flows through: `preprocess → train → eval`.

**Why this matters:** You don't need to plan the full pipeline upfront. Start step 1, work on other things, and chain step 2 when you figure out what it should be. The chain auto-executes as each link completes.

### 🎯 Conditional Chains

Control **when** a chained task runs:

```
# Only evaluate on training success
promise-create(
  command="python train.py",
  then="python eval.py",
  thenCondition="on-success"
)

# Send alert only if something fails
promise-then(
  promiseId="promise-abc",
  command="curl -X POST https://alerts.example.com/fail",
  condition="on-failure"
)

# Download a model checkpoint only after training succeeds
promise-then(
  promiseId="promise-abc",
  download="https://example.com/checkpoint.pt",
  path="./checkpoint.pt",
  condition="on-success"
)
```

If a condition isn't met, a "skipped" promise is created (status `cancelled`) with a message explaining why.

### 🧵 Multi-Step Pipeline Pattern

```
# Fire steps without ever blocking:
promise-create(command="step1", name="full-pipeline")
promise-then(promiseId="promise-abc", command="step2", condition="on-success")
promise-then(promiseId="promise-abc", command="step3", condition="on-success")
promise-then(promiseId="promise-abc", command="notify-failure", condition="on-failure")

# Meanwhile, do other work...
read(path="./docs/api.md")
edit(path="./src/app.ts", ...)
```

The status bar tracks all chains:

```
①→$●→$○→$○→$○  ●1
```

### 📊 Status Bar (TUI)

The extension adds a live promise status bar to the pi TUI footer.

**Compact view** — always visible:

```
①→$✓→$○ | ②→$●  ●1 ✓1
```

Variant D format: each chain is a root-indexed path showing type + status per node.
- `①→$✓→$○` = root 1's command completed, next command pending
- `②→$●` = root 2's command running
- Trailing `●1 ✓1` = aggregate counts

**Expanded view** — press `ctrl+shift+b`:

```
 ⚡ Background Promises

 ✓ $ full-pipeline
   └─→ ✓ $ step2 (on-success)
        └─→ ○ $ step3 (on-success)
        └─→ ⊘ $ notify-failure (on-failure — skipped)

Press ctrl+shift+b to collapse
```

### Smart Await Heuristics

`promise-await` is rarely needed but smart when used:
- **Downloads**: File-growth detection — polls file size, times out only after no progress for N seconds, considers done after a grace period
- **Commands**: Polls for process exit, returns stdout/stderr

### Process Cleanup

- Cancel kills child process with `SIGTERM`
- No orphaned processes when pi exits

---

## Workflow Examples

### Parallel work (the ideal pattern)

```
User: "Run the test suite and while it runs, review the new API routes"

Agent:
  → promise-create(command="npm test", name="test-suite")          ← fire
  → read(path="./src/routes/api.ts")                               ← work
  → [identifies issues, suggests fixes]                            ← work

🔔 Promise "test-suite" completed!                                 ← auto
  Result: { output: "PASS 42/42" }

  → "All 42 tests pass. About the API routes..."
```

### Multi-step pipeline with fallback

```
User: "Process the data, train a model, and evaluate it. If anything fails, send an alert."

Agent:
  → promise-create(command="python preprocess.py --input raw.csv",
                   name="pipeline")
  → promise-then(promiseId="promise-abc", command="python train.py --epochs 100",
                 condition="on-success")
  → promise-then(promiseId="promise-abc", command="python eval.py",
                 condition="on-success")
  → promise-then(promiseId="promise-abc",
                 command="curl -X POST https://alerts/mypipeline/fail",
                 condition="on-failure")

  → [meanwhile, works on documentation, reviews code, etc.]
```

### Chained download + processing

```
Agent:
  → promise-create(download="https://dataset.example.com/large.zip",
                   path="./data/large.zip", name="get-data")
  → promise-then(promiseId="promise-abc",
                 command="unzip -o ./data/large.zip -d ./data/",
                 condition="on-success")
  → promise-then(promiseId="promise-abc",
                 command="python preprocess.py --dir ./data/",
                 condition="on-success")

  → [meanwhile, reads paper, reviews architecture, etc.]
```

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
