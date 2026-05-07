# Sub-Agent Orchestration Patterns

The bg-promises chaining system is designed to orchestrate sub-agents — independent AI sessions that work on subtasks and report back. This pattern lets you parallelize cognitive work, not just shell commands.

> **Note:** Sub-agent support (`type="agent"`) is a planned extension of the promise system. The patterns below show how the existing chaining primitives would compose with sub-agents once available.

## Why Sub-Agents

Some tasks benefit from dedicated agent sessions:

| Task | Why a sub-agent |
|------|----------------|
| Analyze test output | Deep focus on logs without distracting the main agent |
| Research a topic | Independent web search and synthesis |
| Review code changes | Fresh perspective on a diff |
| Generate documentation | Parallel writing while main agent codes |
| Investigate a bug | Trace through code independently |

## Basic Sub-Agent

Spawn an agent to work on a focused task:

```
promise-create(
  type="agent",
  task="Analyze the test failures in ./test-results/ and list root causes",
  context=["./test-results/", "./src/"],
  name="test-analysis"
)

→ [main agent continues working on other features]

🔔 Promise "test-analysis" completed!
  Result: { "findings": ["Race condition in Cache.update()", ...] }
```

## Pipeline: Review → Fix → Verify

Chain sub-agents to form an automated review-fix-verify loop:

```
promise-create(
  type="agent",
  task="Review ./src/ for potential null pointer issues",
  context=["./src/"],
  name="code-review"
)
promise-then(
  promiseId="promise-abc",
  type="agent",
  task="Apply fixes for the issues found in the previous step",
  condition="on-success",
  name="auto-fix"
)
promise-then(
  promiseId="promise-abc",
  type="agent",
  task="Run the test suite and confirm all fixes pass",
  command="npm test",
  condition="on-success",
  name="verify"
)
promise-then(
  promiseId="promise-abc",
  type="agent",
  task="Report what was fixed and any remaining issues",
  condition="always",
  name="report"
)
```

## Research + Implement

One sub-agent researches while another awaits results:

```
promise-create(
  type="agent",
  task="Research the best approach for implementing retry logic with exponential backoff in Python. Include code examples.",
  name="research-retry"
)
promise-then(
  promiseId="promise-abc",
  type="agent",
  task="Implement the retry pattern researched in the previous step. Add it to ./src/retry.py",
  context=["./src/"],
  condition="on-success",
  name="implement-retry"
)
```

## Bug Investigation with Fallback

```
promise-create(
  type="agent",
  task="Investigate the flaky test 'test_user_login' in ./tests/ and find the root cause",
  context=["./tests/", "./src/auth/"],
  name="bug-hunt"
)
promise-then(
  promiseId="promise-abc",
  type="agent",
  task="Implement a fix for the bug found in the previous step",
  condition="on-success",
  name="apply-fix"
)
promise-then(
  promiseId="promise-abc",
  type="agent",
  task="Since the automated investigation failed, create a detailed bug report with reproduction steps for manual triage",
  condition="on-failure",
  name="escalate"
)
```

## Parallel Sub-Agents (Fan-Out)

Fire multiple independent research tasks simultaneously:

```
promise-create(
  type="agent",
  task="Research Python async frameworks: compare FastAPI, Quart, and Sanic",
  name="research-frameworks"
)
promise-create(
  type="agent",
  task="Research best practices for WebSocket handling in Python",
  name="research-websockets"
)
promise-create(
  type="agent",
  task="Find example production deployments of async Python at scale",
  name="research-deployments"
)

→ [main agent works on architecture design]

🔔 All three research tasks complete
→ Synthesize findings into a recommendation
```

## Key Design Principle

Sub-agent chains follow the same rules as command chains:
- **`condition="on-success"`** — next agent only runs if previous succeeded
- **`condition="on-failure"`** — debug/escalate agent triggers on failure
- **`condition="always"`** — notification/cleanup always runs
- **`promise-then`** appends to the chain — build pipelines incrementally
- All notifications auto-deliver — no polling
