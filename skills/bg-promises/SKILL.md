---
description: Run background tasks without blocking — fire promises, keep working, results auto-deliver
---

# bg-promises — Async Background Workflow

**Default to using promises.** Whenever you can work on something else while a task runs, fire a promise and keep going. The result will arrive automatically as a `[System]` notification — no polling, no blocking, no context-switching cost.

---

## Core Philosophy

| Situation | Default action |
|-----------|---------------|
| Task takes >2 seconds and you have other work | ✅ `promise-create(subject=..., intent=..., ...)` → **keep working on DIFFERENT tasks** |
| You need to do something after a task finishes | ✅ Use the `intent` parameter — it executes automatically |
| You have nothing else to do while a promise runs | ✅ Stop your turn — the `[System]` notification will wake you |

**Never block on a promise.** There is no reason to. The result auto-delivers as a `[System]` message, and the notification pulls you back into the conversation. If you have nothing else to do, just stop — the promise system wakes you up naturally.

---

## How It Works

1. **Fire**: `promise-create(command=..., name=..., intent=...)` 
2. **Keep working** on DIFFERENT tasks while the promise runs
3. **Auto-deliver**: When the promise completes, a `[System]` notification arrives with the intent
4. **Execute intent**: The agent acts on the intent automatically — no user interaction needed

```
User: "Run tests and review the code"

Agent:
  → promise-create(command="npm test", name="tests", intent="report results")
  → read(path="./src/app.ts")                    ← DIFFERENT task
  → [reviews code, suggests improvements]

[System] Promise completed: run tests
Intent: report results

Agent: [executes intent automatically]            ← proactive, doesn't ask user
```

---

## Intent — Proactive Auto-Execution

When creating a promise, specify an **intent** — what to do after it completes. The agent executes the intent automatically when notified.

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

### At creation time (`then` parameter)

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
  promiseId="promise-abc",
  command="python eval.py",
  condition="on-success"
)
```

### Conditions reference

| Condition | Chain runs when parent... |
|-----------|--------------------------|
| `"always"` (default) | completes or fails |
| `"on-success"` | completes successfully |
| `"on-failure"` | fails |

If condition not met, a "skipped" promise is created (status `cancelled`) with an explanatory message.

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

| Situation | Use |
|-----------|-----|
| Same exact job, already running | `dedup=true` |
| Same exact job, already done | `dedup=true` |
| Modified code, need re-run | `replace=true` |
| First time running this task | Neither |

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

 ✓ $ pipeline
   └─→ ✓ $ train (on-success)
        └─→ ○ $ eval (on-success)

Press F4 to collapse
```

---

## ⚠️ Common Pitfalls

### Don't duplicate work

```
❌ BAD:
  promise-create(command="npm test", subject="run tests")
  → also runs npm test manually

✅ GOOD:
  promise-create(command="npm test", subject="run tests")
  → work on DIFFERENT things while it runs
```

### Chains are linear, not trees

Each promise can have **one** child. If you need two steps after the same parent (on-success and on-failure), use separate chains.

### Failure cascades

If step A fails, every `on-success` step downstream is cancelled. Each gets a notification explaining why.

---

## `/promise` Command

| Command | Action |
|---------|--------|
| `/promise` | Toggle expanded status bar |
| `/promise 1` | Show live tmux output for root promise #1 |
| `/promise <name>` | Show live output by promise name |
| `/promise stop` | Close the live output view |

---

## Behavior on pi shutdown

On `session_shutdown`:
- Running promises are saved to scoped state file
- Tmux sessions survive reload for reconnection

On `session_start`:
- Promises restored from state file
- Tmux sessions re-discovered and reconnected
- Orphaned sessions from other instances cleaned up

---

## Related Tools

- `promise-create` — start a background task with intent
- `promise-then` — chain a task after an existing promise
- `promise-rechain` — re-attach a cancelled/failed promise to a different parent
- `promise-graph` — inspect chain relationships
- `promise-status` — non-blocking status check
- `promises-list` — list all promises as a chain tree
- `promise-cancel` — cancel a running task

---

## Examples

Detailed patterns in the `examples/` directory:

| File | Covers |
|------|--------|
| [downloading.md](examples/downloading.md) | Basic download, download+process, conditional downloads |
| [pipelines.md](examples/pipelines.md) | Data processing, ML training, CI/CD, dynamic pipelines |
| [parallel-work.md](examples/parallel-work.md) | Fan-out/gather, work-while-waiting, parallel analysis |
| [failure-recovery.md](examples/failure-recovery.md) | Retry with backoff, cleanup, debug agent on failure |
| [sub-agents.md](examples/sub-agents.md) | Sub-agent orchestration, research+implement, bug investigation |
