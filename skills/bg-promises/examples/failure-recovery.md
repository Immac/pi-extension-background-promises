# Failure Recovery Patterns

Handle errors gracefully without blocking the main workflow.

## Basic Failure Handling

Chain a notification step that only runs on failure:

```
promise-create(command="python train.py --epochs 100", name="train-model")
promise-then(
  promiseId="promise-abc",
  command="curl -X POST https://alerts.example.com/train-failed -d 'Training crashed'",
  condition="on-failure",
  name="alert-on-fail"
)
promise-then(
  promiseId="promise-abc",
  command="python train.py --epochs 50 --lr 0.0001",
  condition="on-failure",
  name="retry-with-lower-lr"
)
```

## Retry with Backoff

```
promise-create(command="python deploy.py --env staging", name="deploy")
promise-then(
  promiseId="promise-abc",
  command="sleep 5 && python deploy.py --env staging",
  condition="on-failure",
  name="retry-1"
)
promise-then(
  promiseId="promise-abc",
  command="sleep 15 && python deploy.py --env staging",
  condition="on-failure",
  name="retry-2"
)
promise-then(
  promiseId="promise-abc",
  command="curl -X POST https://alerts/deploy-failed -d 'Deploy failed after 3 attempts'",
  condition="on-failure",
  name="escalate"
)
```

Chain visualisation:
```
①→$✗→$○→$○→$○  ●3
  (deploy failed → retry-1 → retry-2 → escalate)
```

## Cleanup on Failure

Always clean up temporary resources regardless of outcome:

```
promise-create(command="python process_batch.py --input batch.csv", name="batch-job")
promise-then(
  promiseId="promise-abc",
  command="rm -rf ./temp/batch_*",
  condition="on-failure",
  name="cleanup-on-fail"
)
promise-then(
  promiseId="promise-abc",
  command="mv ./output/batch.csv ./archive/",
  condition="on-success",
  name="archive-on-success"
)
```

## Debug Agent on Failure

When something fails, spawn analysis to understand why:

```
promise-create(command="npm run test:integration", name="integration-tests")
promise-then(
  promiseId="promise-abc",
  agent="analyze",
  task="Examine the test output and logs, identify root cause of integration test failures",
  context=["./test-results/", "./logs/"],
  condition="on-failure",
  name="analyze-failure"
)
promise-then(
  promiseId="promise-abc",
  agent="implement",
  task="Based on the failure analysis, implement fixes for the failing integration tests",
  context=["./src/", "./tests/"],
  condition="on-success",
  name="auto-fix"
)
```

This creates an automated loop: **test → fail → analyze → fix → test again**.

## Conditional Cleanup (always + branching)

Use `condition="always"` for logging/telemetry, then branch:

```
promise-create(command="python etl.py", name="etl-job")
promise-then(
  promiseId="promise-abc",
  command="python log_result.py --job etl --status $?",
  condition="always",
  name="log-outcome"
)
promise-then(
  promiseId="promise-abc",
  command="python cleanup_temp.py",
  condition="on-failure",
  name="cleanup"
)
promise-then(
  promiseId="promise-abc",
  command="python trigger_next_job.py",
  condition="on-success",
  name="trigger-next"
)
```

Note that `condition="always"` runs regardless, and the subsequent conditional chains evaluate independently based on the parent's status.

## Health Check Loop

Periodically health-check a long-running service:

```
promise-create(command="python start_server.py", name="server")
promise-then(
  promiseId="promise-abc",
  command="python health_check.py --endpoint http://localhost:8080/health --max-retries 3",
  condition="on-success",
  name="verify-healthy"
)
promise-then(
  promiseId="promise-abc",
  command="python restart_server.py && python health_check.py --endpoint http://localhost:8080/health",
  condition="on-failure",
  name="restart-on-unhealthy"
)
promise-then(
  promiseId="promise-abc",
  command="python notify_sre.py --msg 'Server failed to start after restart'",
  condition="on-failure",
  name="sre-alert"
)
```

## Summary of Failure Flow

```
                    ┌─ on-success ──► next step
                    │
root command ───────┼─ on-failure ──► cleanup / retry / alert
                    │
                    └─ always ──────► log / telemetry
```

The key insight: **failure isn't the end of the pipeline**. Chain recovery steps, retries, analysis, or notifications — all without the main agent blocking or context-switching.
