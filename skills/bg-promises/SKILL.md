---
description: Run background tasks without blocking — fire promises, keep working, results auto-deliver
---

# bg-promises — Async Background Workflow

Use this skill when you need to run a long-running task (download, data processing, model training, etc.) without blocking your current work.

## How It Works

1. **Start**: Call `promise-create(command=... name=...)` or `promise-create(download=... path=... name=...)`
2. **Continue**: Keep answering the user's questions, editing files, reading code — anything you can do while the task runs
3. **Notification**: When the task completes, a message is automatically injected into the conversation:

```
🔔 Promise "my-task" completed!
• Type: command
• Result: { "output": "..." }
```

4. **Use result**: Continue the workflow using the delivered result. If you need structured details, call `promise-await(promiseId)`.

## Workflow Example

### Starting a download while working on something else

```
User: "Download the latest model and then review the training script"

You:
1. promise-create(download="https://...", path="./model.bin", name="download-model")
   → promiseId: "promise-123"

2. read(path="./train.py")                    ← keep working
3. edit(path="./train.py", ...)               ← keep working

4. 🔔 Promise "download-model" completed!     ← auto-delivered
   Result: { path: "./model.bin", size: 1234567 }

5. "The model has been downloaded. Looking at the training script..."
```

### Running a long command while doing other prep work

```
User: "Run the full test suite and while it runs, review the new feature code"

You:
1. promise-create(command="npm test", name="test-suite")
   → promiseId: "promise-456"

2. read(path="./src/new-feature.ts")          ← keep working
3. identify issues in the new feature code

4. 🔔 Promise "test-suite" completed!         ← auto-delivered
   Result: { output: "PASS 42/42 tests" }

5. "All 42 tests pass. Here are my thoughts on the new feature..."
```

### Chaining commands

```
promise-create(
  command="python preprocess.py --input data.csv",
  then="python train.py --epochs 50"
)
```

Both steps auto-deliver results. The first completes, then the second runs automatically.

### Explicit wait (when you need the result NOW)

```
promise-create(command="python analyze.py --input data.json", name="analyze")
→ promiseId: "promise-789"

[If you absolutely cannot continue without the result:]
promise-await(promiseId="promise-789")
→ { success: true, result: { output: "..." } }
```

## Status Bar (TUI)

The extension adds a status bar to the pi TUI footer showing promise activity:

- **Compact** (default): Shows colored counts in the footer — `●N` running, `✓N` done, `✗N` failed
- **Expanded**: Press `ctrl+shift+b` to show a detailed widget below the editor with all promises, their status icons, type indicators, and result/error summaries

```
⚡ Background Promises

 ● $ train-model     Running: python train.py --epochs 50
 ✓ ↓ data.csv        {"path": "./data.csv", "size": 12345}
 ✗ $ preprocess      Command exited with code 1

Press ctrl+shift+b to collapse
```

## Related Tools

- `promise-create` — start background task
- `promise-await` — block until done (usually not needed)
- `promise-status` — non-blocking check
- `promises-list` — list all pending/completed promises
- `promise-cancel` — cancel a running task
- `ctrl+shift+b` — toggle expanded promise status bar
