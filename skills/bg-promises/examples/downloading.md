# Downloading Patterns

All examples assume you've fired a download and are working on other things while it runs.

## Basic Download

```
User: "Download the latest model checkpoint"

You:
→ promise-create(
    download="https://example.com/models/checkpoint.pt",
    path="./models/checkpoint.pt",
    name="get-checkpoint"
  )
→ [continues reviewing code, editing files, etc.]

🔔 Promise "get-checkpoint" completed!
  Result: { path: "./models/checkpoint.pt", size: 847213568 }
```

## Download + Auto-Process

Chain extraction or processing after the download completes:

```
promise-create(
  download="https://example.com/data/dataset.zip",
  path="./data/dataset.zip",
  name="fetch-data"
)
promise-then(
  promiseId="promise-abc",
  command="unzip -o ./data/dataset.zip -d ./data/raw",
  condition="on-success"
)
promise-then(
  promiseId="promise-abc",
  command="python preprocess.py --dir ./data/raw --out ./data/processed",
  condition="on-success"
)
```

This downloads, unzips, and preprocesses — three steps, zero blocking.

## Conditional Download

Only download if the previous step succeeded:

```
promise-create(command="python check-version.py", name="verify-env")
promise-then(
  promiseId="promise-abc",
  download="https://example.com/models/large-model.bin",
  path="./models/large-model.bin",
  condition="on-success"
)
```

## Fallback on Download Failure

Try primary source, fall back to mirror on failure:

```
promise-create(
  download="https://primary-cdn.example.com/data.zip",
  path="./data.zip",
  name="primary-download"
)
promise-then(
  promiseId="promise-abc",
  download="https://mirror.example.com/data.zip",
  path="./data.zip",
  condition="on-failure",
  name="mirror-fallback"
)
```

## Multi-File Download (fan-out)

Fire multiple independent downloads at once:

```
promise-create(download="https://.../file_a.csv", path="./data/file_a.csv", name="dl-a")
promise-create(download="https://.../file_b.csv", path="./data/file_b.csv", name="dl-b")
promise-create(download="https://.../file_c.csv", path="./data/file_c.csv", name="dl-c")

→ [work on other things while all three download in parallel]

🔔 Promise "dl-a" completed!
🔔 Promise "dl-b" completed!
🔔 Promise "dl-c" completed!

→ "All three files are downloaded. Let me process them..."
```

## Download with Progress Check

Fire a download, check status later without blocking:

```
promise-create(download="https://.../big-file.bin", path="./big-file.bin", name="big-dl")

→ [work on other things]

promise-status(promiseId="promise-abc")
→ { status: "running", lastKnownSize: 52428800 }

→ [keep working, notification will arrive]
```
