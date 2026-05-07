---
description: Run background tasks without blocking — fire promises, keep working, results auto-deliver
---

# bg-promises — Async Background Workflow

**Default to using promises.** Whenever you can work on something else while a task runs, fire a promise and keep going. The result will arrive automatically — no polling, no blocking, no context-switching cost.

---

## Core Philosophy

| Situation | Default action |
|-----------|---------------|
| Task takes >2 seconds and you have other work | ✅ `promise-create(...)` → **keep working** |
| You need to do something after a task finishes | ✅ `promise-then(promiseId=..., command=...)` |
| You absolutely need the result to continue | ✅ `promise-then(promiseId=..., command=...)` — still don't block |
| You must block (no other work possible) | ⚠️ `promise-await(promiseId=...)` — last resort |

**Do not wait if you can work.** Every time you use `promise-create`, you give yourself the ability to answer more of the user's questions, review more code, or chain next steps — all while the task runs.

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
1. promise-create(command="npm test", name="test-suite")
   → promiseId: "promise-456"

2. read(path="./src/new-feature.ts")          ← work while tests run
3. identify issues in the new feature code     ← work while tests run

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

### Expanded view (`ctrl+shift+b`)

Shows a detailed tree below the editor:

```
 ⚡ Background Promises

 ✓ $ pipeline
   └─→ ✓ $ train (on-success)
        └─→ ○ $ eval (on-success)
        └─→ ⊘ $ alert (on-failure — skipped)

Press ctrl+shift+b to collapse
```

---

## When NOT to use promises

- **Reading small files** — just use `read()`
- **Quick git operations** — just run inline
- **User interaction** (auth prompts, confirmations) — must block
- **The result is needed before any other work is possible** — rare, use `promise-await`

Otherwise: **fire a promise.**

---

## Related Tools

- `promise-create` — start a background task
- `promise-then` — chain a task after an existing promise
- `promise-await` — block until done (rarely needed)
- `promise-status` — non-blocking check
- `promises-list` — list all promises
- `promise-cancel` — cancel a running task
- `ctrl+shift+b` — toggle expanded promise status bar
