---
description: Run background tasks without blocking — fire promises, keep working, results auto-deliver
---

# bg-promises — Async Background Workflow

**Default to using promises.** Whenever you can work on something else while a task runs, fire a promise and keep going. The result will arrive automatically — no polling, no blocking, no context-switching cost.

---

## Core Philosophy

| Situation | Default action |
|-----------|---------------|
| Task takes >2 seconds and you have other work | ✅ `promise-create(subject=..., ...)` → **keep working on DIFFERENT tasks** |
| You need to do something after a task finishes | ✅ `promise-then(promiseId=..., command=...)` |
| You have nothing else to do while a promise runs | ✅ Stop your turn — the 🔔 notification will wake you when ready |

**Never block on a promise.** There is no reason to. The result auto-delivers as a message, and the notification pulls you back into the conversation. Blocking replaces productive work with dead time. If you have nothing else to do, just stop — the promise system wakes you up naturally.

**Do not wait if you can work — but work on DIFFERENT things.** Every time you use `promise-create`, you give yourself the ability to answer more of the user's questions, review more code, or chain next steps — all while the task runs. Use `subject` to label what the promise handles, and do NOT start working on that same task yourself.

---

## How It Works

1. **Fire**: `promise-create(command=... name=...)` or `promise-create(download=... path=... name=...)`
2. **Chain** (optional): Attach follow-ups at any time with `promise-then(promiseId=..., command=...)`
3. **Work**: Keep reading files, editing code, answering questions, starting more promises
4. **Auto-deliver**: Each completed/failed promise injects a message into the conversation:

```
🔔 Promise "my-task" completed!
• Type: command
• Result: { "output": "..." }
```

5. **Continue**: The result is in your context. Use it.

---

## Workflow Examples

### Parallel work (the ideal pattern)

```
User: "Run the full test suite and review the new feature code"

You:
1. promise-create(command="npm test", name="test-suite",
                  subject="run test suite")
   → promiseId: "promise-456"

2. read(path="./src/new-feature.ts")          ← DIFFERENT task — safe
3. identify issues in the new feature code     ← DIFFERENT task — safe

4. 🔔 Promise "test-suite" completed!         ← auto-delivered
   Result: { output: "PASS 42/42 tests" }

5. "All 42 tests pass. Here are my thoughts on the new feature..."
```

### Download while reading docs

```
User: "Download the latest model and then review the training script"

You:
1. promise-create(download="https://...", path="./model.bin", name="download-model")
   → promiseId: "promise-123"

2. read(path="./train.py")                    ← work while downloading
3. edit(path="./train.py", ...)               ← work while downloading

4. 🔔 Promise "download-model" completed!     ← auto-delivered
   Result: { path: "./model.bin", size: 1234567 }

5. "The model has been downloaded. Looking at the training script..."
```

### Multi-step pipeline with post-hoc chaining

```
User: "Process data, train a model, and evaluate it. Start with the data."

You:
1. promise-create(command="python preprocess.py --input raw.csv", name="pipeline")
   → promiseId: "promise-abc"

   [Later, when you know next steps:]
2. promise-then(promiseId="promise-abc", command="python train.py --epochs 50",
                condition="on-success")
3. promise-then(promiseId="promise-abc", command="python eval.py",
                condition="on-success")
4. promise-then(promiseId="promise-abc", command="curl alert.example.com/fail",
                condition="on-failure")

5. [Meanwhile, review architecture, read docs, answer user questions]

6. 🔔 "pipeline" → "train" → "eval" all auto-deliver
```

### Chained download + processing

```
You:
1. promise-create(download="https://example.com/data.zip", path="./data.zip",
                  name="fetch-data")
2. promise-then(promiseId="promise-abc",
                command="unzip -o data.zip -d ./data/",
                condition="on-success")
3. promise-then(promiseId="promise-abc",
                command="python process.py --dir ./data/",
                condition="on-success")

4. [Meanwhile, review schema, read data dictionary, etc.]
```

---

## Chaining — Detailed Reference

### At creation time (`promise-create`'s `then`)

```js
promise-create(
  command="python preprocess.py",
  then="python train.py --epochs 50",
  thenCondition="on-success"   // optional: "always" (default), "on-success", "on-failure"
)
```

### After the fact (`promise-then`)

```js
promise-then(
  promiseId="promise-abc",     // any existing promise (running, completed, or pending)
  command="python eval.py",    // or download="..." with path="..."
  condition="on-success",      // optional: "always" (default), "on-success", "on-failure"
  name="eval-step"             // optional name for the chained promise
)
```

**Multiple calls create a sequential chain.** Each appends to the end:

```
promise-create(command="step1", name="pipe")
→ promise-then(promiseId="pipe-id", command="step2")  ← runs after step1
→ promise-then(promiseId="pipe-id", command="step3")  ← runs after step2
```

### Conditions reference

| Condition | Chain runs when parent... |
|-----------|--------------------------|
| `"always"` (default) | completes or fails |
| `"on-success"` | completes successfully (status `completed`) |
| `"on-failure"` | fails (status `failed`) |

If condition not met, a "skipped" promise is created (status `cancelled`) with an explanatory error message. Auto-notification fires so you know it was skipped.

### Downloads in chains

```js
promise-then(
  promiseId="promise-abc",
  download="https://example.com/model.bin",
  path="./model.bin",
  condition="on-success"
)
```

---

## Status Bar (TUI)

The extension adds a live promise status bar to the pi TUI footer.

### Compact view (always visible)

Shows each root promise's chain as a compact path:

```
①→$✓→$○ | ②→$●  ●1 ✓1
```

- `①`, `②` — root promise index
- `→` — chain link
- `$` / `↓` — command / download type
- `✓` `●` `○` `✗` `⊘` — completed, running, pending, failed, cancelled
- Trailing `●1 ✓1` — aggregate counts

### Expanded view (`F4`)

Shows a detailed tree below the editor:

```
 ⚡ Background Promises

 ✓ $ pipeline
   └─→ ✓ $ train (on-success)
        └─→ ○ $ eval (on-success)
        └─→ ⊘ $ alert (on-failure — skipped)

Press F4 to collapse
```

### Progress tracking (`PROMISE_PROGRESS:N`)

**HIGHLY SUGGESTED** for long-running commands. Add progress markers to show a live block progress bar in the footer instead of the default circle animation:

```bash
for i in $(seq 0 100); do
  echo "PROMISE_PROGRESS:$i"
  heavy_step $i
done
```

The footer shows:

```
[F4] ①→$[████] 85% "Processing..."  ✓3
```

- `[    ]` → `[████]` block bar fills as progress increases
- Completed bars age: `█→▓→▒→░` (newest → oldest)
- Last stdout line shown in quotes, updating in real-time
- `PROMISE_PROGRESS:N` lines are **auto-filtered** from the final output result

No extra tool parameters needed — just add the `echo` to your command.

---

## ⚠️ Avoiding Duplicate Work (Common Pitfall)

**The mistake:** Firing a promise for task X, then immediately ALSO running that same command/task yourself. This wastes work, produces stale results, and confuses the flow.

**Why this happens:** The `promise-create` tool returns "Started command: promise-123" which looks like just an ID — it doesn't 
explicitly say "do not touch this task." The agent then thinks "I should also start this in case the promise doesn't work." **This is wrong.**

```
❌ BAD:
  promise-create(command="check if marked is installed", subject="check marked")
  → reads output... "marked not installed!"
  → installs marked and builds site manually
  → 🔔 Promise completes: "marked not installed" — stale, already handled

✅ GOOD:
  promise-create(command="check if marked is installed", subject="check marked")
  → Trust the promise. Work on something DIFFERENT while it runs.
  → 🔔 Promise completes: "marked not installed"
  → Now install marked based on the fresh result.
```

### Acting on Results

When a promise completion notification arrives, the result is fresh and ready to use:
- **✅ Completed** — inspect the output, use it naturally
- **❌ Failed** — diagnose the error, retry if appropriate
- **⏱ Cancelled** — check the reason, rechain if needed

Don't start the **same** task manually while a promise handles it — work on other things instead. When the result arrives, use it like any other tool result.

### Decision table

| Situation | Action |
|-----------|--------|
| Promise `subject` covers task X | Work on other things; result will auto-deliver |
| No promise covers task X | Safe to work on X directly |
| Promise notification arrives | Use the result naturally — it's fresh, not stale |
| Unsure what promises exist | Call `promise-graph()` or `promises-list()` — check `subject` fields |

### 🎯 Dedup and Replace — Programmatic Duplicate Prevention

Beyond manual checking, the promise system has built-in dedup and replace semantics via `promise-create` parameters. These let the LLM declaratively say "don't duplicate this work" or "replace the old version of this work".

#### `dedup=true` — Reuse existing work

When a promise with the same `subject` already exists (and hasn't failed or been cancelled), `dedup=true` skips creation and returns the existing promise's ID. The LLM can then monitor or await the existing promise instead of starting redundant work.

```
// First call: creates a new promise
promise-create(command="npm test", subject="run test suite", name="test-suite")
→ promiseId: "promise-abc"

// Second call (same subject): dedup finds the running promise, returns its ID
promise-create(command="npm test", subject="run test suite", name="test-suite", dedup=true)
→ "Dedup: promise with subject 'run test suite' currently running — returning existing promise-abc"

// The LLM now knows promise-abc covers this work and can await it if needed
```

**Dedup behavior by existing promise status:**

| Existing status | Dedup action |
|----------------|-------------|
| `pending` or `running` | Return existing ID — don't duplicate |
| `completed` | Return existing ID — result already available |
| `failed` | Create new — old one didn't succeed, retry |
| `cancelled` | Create new — old one was cancelled, start fresh |

> **Why return completed promises?** The LLM may have been reset, restarted, or forgotten about the earlier work. Returning the completed promise lets it get the result without re-execution.

#### `replace=true` — Cancel and restart

When the work has changed (e.g., code was modified and tests need re-running), `replace=true` atomically cancels any existing promise with the same `subject` and creates a fresh one. This is the pattern for "re-run after changes".

```
// First run
promise-create(command="npm test", subject="run test suite", name="test-suite")
→ promiseId: "promise-abc"

// ... modify code ...

// Replace: cancels promise-abc, creates promise-def
promise-create(command="npm test", subject="run test suite", name="test-suite", replace=true)
→ "Started command: promise-def — replaced previous run"
// promise-abc is cancelled with reason "Replaced by new promise with same subject"
// Its children are also cancelled (cascade)
```

**Replace cascades to children:** If the replaced promise has a chain (e.g., test → build → deploy), all children are also cancelled. The new promise starts clean.

#### When to use each

| Situation | Use |
|-----------|-----|
| Same exact job, already running | `dedup=true` — let the original finish |
| Same exact job, already done | `dedup=true` — use cached result |
| Modified code, need re-run | `replace=true` — cancel old, start new |
| Changed requirements | `replace=true` — discard stale work |
| First time running this task | Neither — just create normally |
| Not sure if something is already running | `dedup=true` — safe either way |

#### Combined example: edit-test loop

```
// Step 1: Run initial tests
promise-create(
  command="npm test",
  subject="run tests",
  name="test-suite"
)
→ promiseId: "promise-abc"

// Step 2: While tests run, fix a bug
read(path="./src/buggy.ts")
edit(path="./src/buggy.ts", edits=[{oldText: "bug", newText: "fix"}])

// Step 3: Tests are stale now — replace with fresh run
promise-create(
  command="npm test",
  subject="run tests",
  name="test-suite",
  replace=true            ← cancels old, starts new
)
→ "Started command: promise-def — replaced previous run"

// Step 4: Review another file while new tests run
read(path="./src/other.ts")

🔔 Promise "test-suite" (promise-def) completed!
  Result: { output: "PASS 43/43 tests" }
```

#### Implementation detail

Both `dedup` and `replace` match on the **exact `subject` string**. Use consistent, descriptive subjects like:
- `"run tests"` — for test suites
- `"build project"` — for builds
- `"download model v2"` — for downloads (include version in subject)
- `"lint check"` — for linting

Subjects are case-sensitive and must match exactly for dedup/replace to work.

## When NOT to use promises

- **Reading small files** — just use `read()`
- **Quick git operations** — just run inline
- **User interaction** (auth prompts, confirmations) — must block
- **The result is needed before any other work is possible** — still don't block. Use `promise-then` to chain what needs the result, and keep working on other things.

Otherwise: **fire a promise.**

---

## Chain Pitfalls (Common Confusion Sources)

### 1. `promise-then` always appends to the END of the chain

When you call `promise-then(promiseId="X", command="step")`, the step is appended to the **terminal** of X's chain, not directly to X. If X already has children, `step` runs after the *last* child.

```
promise-create(command="A", name="root")
  → promise-then(promiseId="root", command="B")     ← chain: A → B
  → promise-then(promiseId="root", command="C")     ← chain: A → B → C (not A → C!)
```

Calling `promise-then` on a promise that already has a chain **appends** to the end. Use `promise-graph` or `promises-list` to verify the chain structure after each chaining operation.

### 2. Failure cascades — one break cancels all downstream `on-success` steps

If step A fails, every step in its chain with `condition="on-success"` is cancelled in sequence:

```
A (fails) → B (on-success → cancelled) → C (on-success → cancelled) → D (on-success → cancelled)
```

Each cancelled promise in the chain gets an automatic notification explaining why it was skipped — look for the parent ID and status in the cancellation message.

### 3. Re-chaining after failure requires a fresh attachment

When a step was cancelled because its parent failed, the cancelled step **cannot be re-parented**. It stays in the promise history as cancelled. To retry it:

1. Create a **new root promise** for the step you want to retry (the env setup, data prep, etc.)
2. Use `promise-rechain(fromPromiseId="cancelled-step", toPromiseId="new-completed-step")` — this creates a new promise with the same command and attaches it to the new parent's chain
3. Or manually chain your build/test steps to the new root with `promise-then`

**Before:**
```
  promise-3: create conda env — FAILED
    └─ promise-4: build — CANCELLED [on-success — parent failed]

  promise-5: create conda env — COMPLETED
```

**After `promise-rechain(fromPromiseId="promise-4", toPromiseId="promise-5")`:**
```
  promise-5: create conda env — COMPLETED
    └─ promise-6: build — PENDING [on-success] ← new promise
```

### 4. Check chain structure visually after every chaining operation

`promise-then` now returns the full chain visualization. Always look at the returned tree or path to verify the chain topology is what you intended. You can also call `promise-graph(promiseId=...)` at any time to inspect a specific chain.

### 5. Chains are linear, not trees

Each promise can have **one** child (via `thenPromiseId`). If you need two steps to run after the same parent (e.g., one on-success and one on-failure), they must be on **separate chains** — you cannot branch from a single point.

```
A → B (on-success)  ✓ linear chain
A → C (on-failure)  ✗ cannot branch from same node
                    → must use separate chains
```

See the [failure-recovery.md](examples/failure-recovery.md) example for the correct branching pattern.

## Behavior on pi shutdown

On `session_shutdown` (pi exit or reload):
- **Preserves** running promises — state is saved to `~/.pi/agent/promise-state.json`
- **Clears** all progress polling timers (re-established on next load)
- **Preserves** tmux sessions — they survive reload for reconnection
- `childPid` is cleared (won't survive reload)

**On next load** (`session_start`):
- **Restores** all promises from the state file
- **Re-discovers** tmux sessions by matching session names
- **Reconnects** completion polling, progress tracking, and status bar

This means promises **survive reload**. You can reload pi, and running promises continue in the background with their tmux sessions intact.

**On actual completion** (not shutdown):
- Tmux session is killed
- Temp files cleaned
- Final state saved

## Related Tools

- `promise-create` — start a background task
- `promise-then` — chain a task after an existing promise
- `promise-rechain` — re-attach a cancelled/failed promise to a different parent
- `promise-graph` — inspect chain relationships (tree view for one or all chains)
- `promise-block-until-complete` — ⛔ DEPRECATED — never use. Results auto-deliver. See philosophy above.
- `promise-status` — non-blocking check
- `promises-list` — list all promises as a chain tree
- `promise-cancel` — cancel a running task
- `F4` — toggle expanded promise status bar

---

## Examples

Detailed patterns are in the `examples/` directory alongside this skill:

| File | Covers |
|------|--------|
| [downloading.md](examples/downloading.md) | Basic download, download+process, conditional downloads, multi-file fan-out |
| [pipelines.md](examples/pipelines.md) | Data processing, ML training, CI/CD, dynamic pipelines |
| [parallel-work.md](examples/parallel-work.md) | Fan-out/gather, work-while-waiting, parallel analysis |
| [failure-recovery.md](examples/failure-recovery.md) | Retry with backoff, cleanup, debug agent on failure, health check loops |
| [sub-agents.md](examples/sub-agents.md) | Sub-agent orchestration, research+implement, bug investigation |

Load an example on demand: `read(path="[skill_dir]/examples/downloading.md")`
