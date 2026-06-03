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
| `promise-create` | Start a background task (command or download). Returns immediately. Result auto-delivers. Accepts `subject` (semantic label), `dedup` (reuse existing with same subject), `replace` (cancel & restart with same subject), and `then` + `thenCondition` for initial chaining. |
| `promise-then` | Chain a command or download **after** any existing promise. Multiple calls create a sequence. Supports `condition`: `always` (default), `on-success`, `on-failure`. Returns full chain visualization. |
| `promise-graph` | Inspect chain relationships — tree view for a specific promise or all chains. |
| `promise-rechain` | Re-attach a cancelled/failed promise's command to a different parent chain. |
| `promise-block-until-complete` | ⛔ DEPRECATED — never use. Results auto-deliver. Trust the notification. See reasoning below. |
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

**Default to using promises.** If a task takes more than a few seconds, fire it and move on. The auto-delivery pattern means you never forget about it — the result will arrive when ready.

### Why you should NEVER block on a promise

**The old model:** Fire a task, poll/await it, get result, continue. The agent stands still, watching a progress bar.

**The promise model:** Fire a task, keep working on OTHER things. The result arrives as a message. The agent never stalls.

There is no scenario where blocking beats this model:

| If you need to... | Instead of blocking... | Do this |
|-------------------|----------------------|---------|
| Do something after the promise | `promise-block-until-complete` → chain | `promise-then(promiseId, command=...)` |
| Check if it's done | poll or await | Wait for the 🔔 notification — it auto-delivers |
| Use the result in your response | wait for it | Respond with what you have; the notification will wake you when ready |
| Wait because you have nothing else | block on the promise | Stop your turn — the 🔔 notification wakes you up automatically |

**Even when you have "nothing else to do," blocking is wrong.** Just stop. The promise notification will wake you when the result arrives, and you'll pick up naturally from there. This is the same pattern as telling a human "I'll ping you when it's done" — you don't stand there staring at them.

---

## Features

### 🔔 Auto-Delivery on Completion

All promises (root and chained) auto-deliver results:

```
🔔 Promise "train-model" completed!
• Type: command
• Status: completed
• Result: { "output": "Epoch 50/50 — loss: 0.023" }
You can get full structured details with promise-block-until-complete("promise-xxx").

**Tip:** Instead of blocking, use `promise-then(promiseId=..., command=...)` to chain follow-up work automatically without blocking.
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

After each `promise-then` call, the updated chain is returned as a tree:

```
✓ promise-abc: preprocess (COMPLETED)
  └─ ✓ promise-def: train (COMPLETED)
       └─ ○ promise-ghi: eval (PENDING) ← just added

Path: preprocess (✓ completed) → train (✓ completed) → eval (○ pending)
```

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

### 🚫 Dedup — Don't Duplicate Work (`dedup=true`)

When a promise with the same `subject` already exists (running or completed), `dedup=true` returns the existing promise's ID instead of creating a new one. The LLM avoids redundant work:

```
// First call: normal creation
promise-create(command="npm test", subject="run test suite")
→ promiseId: "promise-abc"

// Second call: dedup finds the running promise, returns its ID
promise-create(command="npm test", subject="run test suite", dedup=true)
→ "Dedup: promise with subject 'run test suite' currently running — returning existing promise-abc"
```

**Dedup behavior by existing status:**
- `running`/`pending` → return existing ID
- `completed` → return existing ID (result available)
- `failed`/`cancelled` → create new (retry)

### 🔄 Replace — Cancel & Restart (`replace=true`)

When work has changed (e.g., code was modified and tests need re-running), `replace=true` atomically cancels any existing promise with the same `subject` and creates a fresh one. Cancellation cascades to all children in the chain:

```
// First run
promise-create(command="npm test", subject="run test suite")
→ promiseId: "promise-abc"

// ... modify code ...

// Replace: cancels promise-abc, creates new promise
promise-create(command="npm test", subject="run test suite", replace=true)
→ "Started command: promise-def — replaced previous run"
```

### 🔄 Re-Chaining After Failure (`promise-rechain`)

When a promise is cancelled because its parent failed (e.g., a build step skipped because env creation failed), use `promise-rechain` to retry it on a different parent:

```
# Scenario: env creation failed, build was auto-cancelled
promise-3: create conda env — FAILED
  └─ promise-4: build — CANCELLED [on-success — parent failed]

# Create a new env
promise-create(command="conda create...", name="new-env")

# Re-chain the build step after the new env
promise-rechain(fromPromiseId="promise-4", toPromiseId="new-env", condition="on-success")

# Result:
new-env — COMPLETED
  └─ promise-6: build — PENDING [on-success] ← new promise spawned from promise-4's command
```

This avoids manually re-creating the build command — `promise-rechain` copies the original command and attaches it to the new parent's chain.

### 📈 Progress Tracking (`PROMISE_PROGRESS:N`)

Commands can report live progress to the TUI footer by printing `PROMISE_PROGRESS:N` (where N is 0-100) to stdout. The promise manager detects these markers automatically and shows a live block progress bar:

```
[F4] ①→$[████] 85% "Processing step 85..."  ✓3
```

The progress bar features:
- **Block bars** — four braille-width slots `[    ]` → `[████]` with fixed-width `⠀` padding
- **Aging gradient** — completed bars fade `█→▓→▒→░` (newest → oldest)
- **Smooth follow** — the active bar smoothly catches up to real progress at a limited speed
- **Boundary snap** — crosses 25/50/75% thresholds cleanly
- **Status message** — the last stdout line is shown in quotes, updating in real-time
- **Auto-filtered** — `PROMISE_PROGRESS:N` lines are stripped from the final command output

**Usage — add to any command:**

```bash
# In a loop
for i in $(seq 0 100); do
  echo "PROMISE_PROGRESS:$i"
  heavy_step $i
done

# Final progress
expensive_command && echo "PROMISE_PROGRESS:100"
```

No extra tool parameters needed. The detection happens automatically in both tmux and direct runners. Works with `stdbuf -oL` for real-time file flushing.

**When not to use:** Short commands that finish in under a second don't benefit from progress tracking. Save it for long-running operations (downloads, builds, training, batch processing).

### 🔍 Chain Inspection (`promise-graph`)

Inspect chain relationships without a full list:

```
promise-graph(promiseId="promise-abc")

  → Chain for promise-abc (build):
    ✓ promise-xyz: env setup (COMPLETED)
      └─ ✓ promise-abc: build (COMPLETED) [on-success]
    Path: env setup (✓ completed) → build (✓ completed)
    Depth: 1 | Status: completed
```

Omit the `promiseId` to see all chains (forest view):

```
promise-graph()
  → Shows all root chains with tree visualization + compact paths
```

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

**Expanded view** — press `F4`:

```
 ⚡ Background Promises

 ✓ $ full-pipeline
   └─→ ✓ $ step2 (on-success)
        └─→ ○ $ step3 (on-success)
        └─→ ⊘ $ notify-failure (on-failure — skipped)

Press F4 to collapse
```

### Smart Await Heuristics

`promise-block-until-complete` is rarely needed but smart when used:
- **Downloads**: File-growth detection — polls file size, times out only after no progress for N seconds, considers done after a grace period
- **Commands**: Polls for process exit, returns stdout/stderr

### Process Cleanup

- Cancel kills child process with `SIGTERM`
- On pi shutdown (`session_shutdown`), all running/pending promises are automatically cancelled, child processes killed, and timers cleaned up — no orphaned processes left behind
- Cancelled promises get status `cancelled` with reason `"pi exited — session ended"`

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

## Skill Examples

The [bg-promises skill](skills/bg-promises/SKILL.md) includes detailed usage examples in its `examples/` directory:

| File | Covers |
|------|--------|
| [downloading.md](skills/bg-promises/examples/downloading.md) | Basic download, download+process, conditional downloads, multi-file fan-out |
| [pipelines.md](skills/bg-promises/examples/pipelines.md) | Data processing, ML training, CI/CD, dynamic pipelines |
| [parallel-work.md](skills/bg-promises/examples/parallel-work.md) | Fan-out/gather, work-while-waiting, parallel analysis |
| [failure-recovery.md](skills/bg-promises/examples/failure-recovery.md) | Retry with backoff, cleanup, debug agent on failure, health check loops |
| [sub-agents.md](skills/bg-promises/examples/sub-agents.md) | Sub-agent orchestration, research+implement, bug investigation |

---

## License

MIT
