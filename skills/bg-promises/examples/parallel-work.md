# Parallel Work Patterns

The core philosophy: **fire multiple things, keep working, results arrive**.

## Parallel Analysis

Run multiple analysis scripts simultaneously:

```
promise-create(command="python analyze_sales.py --month jan", name="analyze-jan")
promise-create(command="python analyze_sales.py --month feb", name="analyze-feb")
promise-create(command="python analyze_sales.py --month mar", name="analyze-mar")

→ [design the Q1 dashboard layout]

🔔 Promise "analyze-jan" completed!
🔔 Promise "analyze-feb" completed!
🔔 Promise "analyze-mar" completed!

→ "All three months analyzed. Here's the Q1 overview..."
```

## Review While Building

Build the app while reviewing related docs:

```
promise-create(command="npm run build", name="build-app")

→ read(path="./docs/architecture.md")
→ identify a potential issue with the module federation config
→ edit(path="./webpack.config.js", ...)

🔔 Promise "build-app" completed!
  Result: { output: "Build succeeded (12s)" }

→ "Build passes. I fixed a module federation config issue I spotted..."
```

## Download + Research in Parallel

```
promise-create(download="https://.../dataset.tar.gz", path="./dataset.tar.gz", name="download-data")
promise-create(type="agent", task="Research the best preprocessing steps for this type of dataset", name="research-prep")

→ read(path="./existing_analysis.py")
→ review the current preprocessing code

🔔 Promise "download-data" completed!
🔔 Promise "research-prep" completed!

→ "Data is downloaded. Based on my research, I recommend we add normalization..."
```

## Fan-Out / Gather Pattern

Fire N parallel tasks, then gather when all complete:

```
// Phase 1: Fan-out — N independent data fetchers
promise-create(command="python fetch_region.py --region us-east", name="fetch-east")
promise-create(command="python fetch_region.py --region eu-west", name="fetch-west")
promise-create(command="python fetch_region.py --region ap-southeast", name="fetch-asia")

// Phase 2: After gathering results (check each, chain merge to each root)
// Main agent sees all three notifications, then fires the merge:
→ "All regions fetched. Merging..."
promise-create(
  command="python merge_regions.py --east ./data/east.json --west ./data/west.json --asia ./data/asia.json --out ./data/combined.json",
  name="merge-all"
)
```

## Work While Waiting

This is the most common and powerful pattern:

```
User: "Run the full test suite and review the new feature code while it runs"

You:
1. promise-create(command="npm test", name="test-suite")
   → promiseId: "promise-456"

2. read(path="./src/new-feature.ts")          ← work while tests run
3. spot a bug in the error handling            ← work while tests run
4. edit(path="./src/new-feature.ts", ...)      ← work while tests run

5. 🔔 Promise "test-suite" completed!         ← auto-delivered
   Result: { output: "PASS 42/42 tests" }

6. "All 42 tests pass. I also fixed a bug in the error handling..."
```

## Multiple Quick Commands (batch)

Fire several quick commands at once for parallel execution:

```
promise-create(command="docker pull python:3.12", name="pull-python")
promise-create(command="docker pull postgres:16", name="pull-postgres")
promise-create(command="docker pull redis:7", name="pull-redis")

→ [write the docker-compose.yml while images download]

🔔 All three images pulled
→ "Environment ready. Here's the docker-compose..."
```
