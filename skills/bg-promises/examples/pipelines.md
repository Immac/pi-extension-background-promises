# Pipeline Patterns

Multi-step pipelines with conditional branching — the bread and butter of background promises.

## Data Processing Pipeline

Process data end-to-end without ever blocking:

```
promise-create(
  command="python fetch.py --date 2024-01-01 --out ./raw/",
  name="pipeline"
)
promise-then(
  promiseId="promise-abc",
  command="python validate.py --dir ./raw/ --schema schema.json",
  condition="on-success",
  name="validate"
)
promise-then(
  promiseId="promise-abc",
  command="python transform.py --in ./raw/ --out ./staging/",
  condition="on-success",
  name="transform"
)
promise-then(
  promiseId="promise-abc",
  command="python load.py --in ./staging/ --db postgres://...",
  condition="on-success",
  name="load"
)
promise-then(
  promiseId="promise-abc",
  command="python notify.py --msg 'Pipeline completed successfully'",
  condition="on-success",
  name="notify-success"
)
promise-then(
  promiseId="promise-abc",
  command="python notify.py --msg 'Pipeline failed' --level error",
  condition="on-failure",
  name="notify-failure"
)
```

The chain visualises as:
```
①→$●→$○→$○→$○→$○→$○  ●1

→ On success: fetch → validate → transform → load → notify-success
→ On failure: fetch → notify-failure
```

## ML Training Pipeline

```
promise-create(
  command="python prepare_data.py --source s3://data/raw --out ./tfrecords",
  name="ml-pipeline"
)
promise-then(
  promiseId="promise-abc",
  command="python train.py --data ./tfrecords --model resnet50 --epochs 50",
  condition="on-success",
  name="train"
)
promise-then(
  promiseId="promise-abc",
  command="python evaluate.py --checkpoint ./checkpoints/latest.pt --out ./metrics.json",
  condition="on-success",
  name="evaluate"
)
promise-then(
  promiseId="promise-abc",
  command="python export.py --checkpoint ./checkpoints/latest.pt --format onnx",
  condition="on-success",
  name="export"
)
promise-then(
  promiseId="promise-abc",
  command="python upload.py --model ./export/model.onnx --registry mlflow://...",
  condition="on-success",
  name="deploy"
)
```

## CI/CD Pipeline

```
promise-create(command="npm run lint", name="ci-pipeline")
promise-then(promiseId="promise-abc", command="npm run typecheck", condition="on-success", name="typecheck")
promise-then(promiseId="promise-abc", command="npm run test:unit", condition="on-success", name="unit-tests")
promise-then(promiseId="promise-abc", command="npm run test:integration", condition="on-success", name="integration-tests")
promise-then(promiseId="promise-abc", command="npm run build", condition="on-success", name="build")
promise-then(promiseId="promise-abc", command="npm run deploy:staging", condition="on-success", name="deploy")
promise-then(promiseId="promise-abc", command="curl -X POST https://alerts/ci/fail", condition="on-failure", name="alert")
```

## Pipeline with User Confirmation Gate

You can pause and await user input between stages:

```
promise-create(command="python analyze.py --input data.csv --out report.json", name="analyze")

🔔 Promise "analyze" completed!
  Result: { output: "Report generated: 500 rows with 12 anomalies" }

→ "I found 12 anomalies in the data. Should I proceed with the cleanup?
   Options: (y)es to continue, (n)o to stop"

User: "yes, clean them up"

promise-then(promiseId="promise-abc", command="python clean.py --rules anomalies.json", name="clean")
promise-then(promiseId="promise-abc", command="python reindex.py", condition="on-success", name="reindex")
```

## Dynamic Pipeline Construction

Build pipelines incrementally as steps complete:

```
promise-create(command="python discover_sources.py", name="dynamic-pipe")

🔔 Promise "discover_sources" completed!
  Result: { output: "Found 3 new data sources: api, db, file" }

→ Based on the output, chain appropriate steps:
promise-then(promiseId="promise-abc", command="python ingest_api.py", name="ingest-api")
promise-then(promiseId="promise-abc", command="python ingest_db.py", name="ingest-db")
promise-then(promiseId="promise-abc", command="python ingest_file.py", name="ingest-file")
```

This is a key advantage of post-hoc chaining: you don't need to know the full pipeline upfront. Decide the next step based on what the previous one produced.
