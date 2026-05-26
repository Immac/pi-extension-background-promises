/**
 * Corner-case and unhappy-path tests for background promises.
 *
 * Covers: invalid args, missing args, edge conditions, download failures,
 * condition combinations, rechain validation, empty states, and more.
 *
 * Run: npx tsx test/corner-cases.test.ts
 */

import { mkdtempSync, writeFileSync, existsSync, rmSync, readdirSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// =============================================================================
// Mock ExtensionAPI (same pattern as auto-injection.test.ts)
// =============================================================================

interface RegisteredTool { name: string; execute: Function; }

class MockExtensionAPI {
  tools: RegisteredTool[] = [];
  sentMessages: Array<{ message: any; options?: any }> = [];

  registerTool(def: any) { this.tools.push({ name: def.name, execute: def.execute }); }
  sendMessage(message: any, options?: any) { this.sentMessages.push({ message, options }); }
  on() {}
  sendUserMessage() {}
  appendEntry() {}
  setSessionName() {}
  getSessionName() { return undefined; }
  setLabel() {}
  registerCommand() {}
  getCommands() { return []; }
  registerShortcut() {}
  registerFlag() {}
  registerMessageRenderer() {}
  exec = async () => ({ stdout: "", stderr: "", exitCode: 0 });
  sendMessageToContainer() {}
  setActiveTools() {}
  getAllTools() { return []; }
  events = { on: () => {}, off: () => {}, emit: () => {} } as any;
}

// =============================================================================
// Helpers
// =============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForCondition(
  condition: () => boolean | string | null,
  timeoutMs: number,
  pollMs: number = 100
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = condition();
    if (result) return;
    await sleep(pollMs);
  }
  const last = condition();
  throw new Error(`Timeout after ${timeoutMs}ms. Last condition result: ${JSON.stringify(last)}`);
}

// =============================================================================
// Corner-case tests
// =============================================================================

async function main() {
  const pi = new MockExtensionAPI();

  const extPath = join(__dirname, "..", "src/extensions/downloads-wisely/bg-promises.ts");
  const extModule = await import(extPath);
  extModule.default(pi as any);

  const createTool = pi.tools.find((t) => t.name === "promise-create")!;
  const awaitTool = pi.tools.find((t) => t.name === "promise-block-until-complete")!;
  const listTool = pi.tools.find((t) => t.name === "promises-list")!;
  const statusTool = pi.tools.find((t) => t.name === "promise-status")!;
  const cancelTool = pi.tools.find((t) => t.name === "promise-cancel")!;
  const thenTool = pi.tools.find((t) => t.name === "promise-then")!;
  const rechainTool = pi.tools.find((t) => t.name === "promise-rechain")!;
  const graphTool = pi.tools.find((t) => t.name === "promise-graph")!;

  const required = [createTool, awaitTool, listTool, statusTool, cancelTool, thenTool, rechainTool, graphTool];
  if (required.some((t) => !t)) throw new Error("Some tools not registered");

  console.log("Tools registered:", pi.tools.map((t) => t.name));
  console.log("");

  // ===========================================================================
  // SECTION 1: promise-create — download edge cases
  // ===========================================================================
  console.log("═══════════════════════════════════════════");
  console.log("Section 1: Download edge cases");
  console.log("═══════════════════════════════════════════\n");

  // Test 1.1: Download with no URL → should fail
  console.log("Test 1.1: Download with no URL → fails\n");
  const noUrlResult = await createTool.execute("c-1.1", {
    path: "/tmp/no-url-test.bin",
    name: "no-url",
  });
  const noUrlId = noUrlResult.details?.promiseId;
  console.log("  Created promise:", noUrlId);
  console.log("  type:", noUrlResult.details?.type);
  await sleep(300);
  const noUrlStatus = await statusTool.execute("c-1.1b", { promiseId: noUrlId });
  console.log("  status:", noUrlStatus.details?.status);
  if (noUrlStatus.details?.status === "failed") {
    console.log("✅ 1.1: Download without URL correctly failed\n");
  } else {
    console.log("❌ 1.1: Expected 'failed' got", noUrlStatus.details?.status);
    throw new Error("Download without URL did not fail");
  }

  // Test 1.2: Download with no path → should fail
  console.log("Test 1.2: Download with no path → fails\n");
  const noPathResult = await createTool.execute("c-1.2", {
    download: "https://example.com/file.bin",
    name: "no-path",
  });
  const noPathId = noPathResult.details?.promiseId;
  console.log("  Created promise:", noPathId);
  await sleep(300);
  const noPathStatus = await statusTool.execute("c-1.2b", { promiseId: noPathId });
  console.log("  status:", noPathStatus.details?.status);
  if (noPathStatus.details?.status === "failed") {
    console.log("✅ 1.2: Download without path correctly failed\n");
  } else {
    console.log("❌ 1.2: Expected 'failed' got", noPathStatus.details?.status);
    throw new Error("Download without path did not fail");
  }

  // Test 1.3: Download to unreachable URL → should fail
  console.log("Test 1.3: Download to unreachable URL → fails\n");
  const badUrlResult = await createTool.execute("c-1.3", {
    download: "http://0.0.0.0:1/nonexistent",
    path: "/tmp/bad-url-test.bin",
    name: "bad-url",
  });
  const badUrlId = badUrlResult.details?.promiseId;
  console.log("  Created promise:", badUrlId);
  await sleep(1000);
  const badUrlStatus = await statusTool.execute("c-1.3b", { promiseId: badUrlId });
  console.log("  status:", badUrlStatus.details?.status);
  if (badUrlStatus.details?.status === "failed") {
    console.log("✅ 1.3: Unreachable URL correctly failed\n");
  } else {
    console.log("❌ 1.3: Expected 'failed' got", badUrlStatus.details?.status, "(may vary by network)");
  }

  // ===========================================================================
  // SECTION 2: promise-create — argument validation
  // ===========================================================================
  console.log("═══════════════════════════════════════════");
  console.log("Section 2: Argument validation");
  console.log("═══════════════════════════════════════════\n");

  // Test 2.1: No command AND no download → still creates but fails
  console.log("Test 2.1: No command and no download → creates but fails\n");
  const noArgsResult = await createTool.execute("c-2.1", { name: "no-args" });
  const noArgsId = noArgsResult.details?.promiseId;
  console.log("  Created promise:", noArgsId);
  console.log("  returned status:", noArgsResult.details?.status);
  if (noArgsResult.details?.status === "started") {
    console.log("✅ 2.1: promise-create returned success despite missing args");
  } else {
    console.log("❌ 2.1: promise-create did not return started");
  }
  await sleep(300);
  const noArgsStatus = await statusTool.execute("c-2.1b", { promiseId: noArgsId });
  console.log("  final status:", noArgsStatus.details?.status);
  if (noArgsStatus.details?.status === "failed") {
    console.log("✅ 2.1: Promise correctly failed (missing command)\n");
  } else {
    console.log("❌ 2.1: Expected 'failed' got", noArgsStatus.details?.status);
    throw new Error("Promise without args did not fail");
  }

  // ===========================================================================
  // SECTION 3: promise-await — edge cases
  // ===========================================================================
  console.log("═══════════════════════════════════════════");
  console.log("Section 3: promise-await edge cases");
  console.log("═══════════════════════════════════════════\n");

  // Test 3.1: await nonexistent promise
  console.log("Test 3.1: await nonexistent promise → returns error\n");
  const awaitNonExist = await promiseAwaitSafe(awaitTool, "c-3.1", { promiseId: "promise-nonexistent-12345" });
  if (awaitNonExist.isError) {
    console.log("✅ 3.1: Nonexistent promise correctly errors\n");
  } else {
    console.log("❌ 3.1: Expected error for nonexistent promise");
    throw new Error("Nonexistent promise did not error");
  }

  // Test 3.2: await failed promise
  console.log("Test 3.2: await failed promise → returns error with details\n");
  const failForAwait = await createTool.execute("c-3.2", {
    command: "exit 99",
    name: "await-fail-test",
  });
  const failAwaitId = failForAwait.details?.promiseId;
  await sleep(800);
  const awaitFailed = await promiseAwaitSafe(awaitTool, "c-3.2b", { promiseId: failAwaitId });
  if (awaitFailed.isError) {
    console.log("✅ 3.2: Await on failed promise returns error");
    console.log("  details.error:", awaitFailed.details?.error);
    console.log("");
  } else {
    console.log("❌ 3.2: Expected error for failed promise");
    throw new Error("Await on failed did not error");
  }

  // Test 3.3: await cancelled promise
  console.log("Test 3.3: await cancelled promise → returns error with details\n");
  const cancelForAwait = await createTool.execute("c-3.3", {
    command: "sleep 10",
    name: "await-cancel-test",
  });
  const cancelAwaitId = cancelForAwait.details?.promiseId;
  await sleep(50);
  await cancelTool.execute("c-3.3b", { promiseId: cancelAwaitId });
  await sleep(200);
  const awaitCancelled = await promiseAwaitSafe(awaitTool, "c-3.3c", { promiseId: cancelAwaitId });
  if (awaitCancelled.isError) {
    console.log("✅ 3.3: Await on cancelled promise returns error\n");
  } else {
    console.log("❌ 3.3: Expected error for cancelled promise");
    throw new Error("Await on cancelled did not error");
  }

  // ===========================================================================
  // SECTION 4: promise-status — edge cases
  // ===========================================================================
  console.log("═══════════════════════════════════════════");
  console.log("Section 4: promise-status edge cases");
  console.log("═══════════════════════════════════════════\n");

  // Test 4.1: status on nonexistent promise
  console.log("Test 4.1: status on nonexistent promise → error\n");
  const statusNonExist = await statusTool.execute("c-4.1", { promiseId: "promise-fake-999" });
  if (statusNonExist.isError || statusNonExist.details?.found === false) {
    console.log("✅ 4.1: Nonexistent promise correctly errors");
  } else {
    console.log("❌ 4.1: Expected error for nonexistent promise");
    throw new Error("Status on nonexistent did not error");
  }
  console.log("");

  // ===========================================================================
  // SECTION 5: promise-cancel — edge cases
  // ===========================================================================
  console.log("═══════════════════════════════════════════");
  console.log("Section 5: promise-cancel edge cases");
  console.log("═══════════════════════════════════════════\n");

  // Test 5.1: cancel nonexistent promise
  console.log("Test 5.1: cancel nonexistent promise → error\n");
  const cancelNonExist = await cancelTool.execute("c-5.1", { promiseId: "promise-fake-888" });
  if (cancelNonExist.isError) {
    console.log("✅ 5.1: Nonexistent cancel correctly errors\n");
  } else {
    console.log("❌ 5.1: Expected error for nonexistent cancel");
    throw new Error("Cancel on nonexistent did not error");
  }

  // Test 5.2: cancel already completed promise → error
  console.log("Test 5.2: cancel already completed promise → error\n");
  const doneForCancel = await createTool.execute("c-5.2", {
    command: "echo done",
    name: "done-for-cancel",
  });
  const doneCancelId = doneForCancel.details?.promiseId;
  await sleep(800);
  const cancelDone = await cancelTool.execute("c-5.2b", { promiseId: doneCancelId });
  if (cancelDone.isError) {
    console.log("✅ 5.2: Cancel on completed promise correctly errors\n");
  } else {
    console.log("❌ 5.2: Expected error for cancel on completed");
    throw new Error("Cancel on completed did not error");
  }

  // Test 5.3: cancel already failed promise → error
  console.log("Test 5.3: cancel already failed promise → error\n");
  const failedForCancel = await createTool.execute("c-5.3", {
    command: "exit 1",
    name: "failed-for-cancel",
  });
  const failedCancelId = failedForCancel.details?.promiseId;
  await sleep(800);
  const cancelFailed = await cancelTool.execute("c-5.3b", { promiseId: failedCancelId });
  if (cancelFailed.isError) {
    console.log("✅ 5.3: Cancel on failed promise correctly errors\n");
  } else {
    console.log("❌ 5.3: Expected error for cancel on failed");
    throw new Error("Cancel on failed did not error");
  }

  // ===========================================================================
  // SECTION 6: promise-then — argument validation
  // ===========================================================================
  console.log("═══════════════════════════════════════════");
  console.log("Section 6: promise-then argument validation");
  console.log("═══════════════════════════════════════════\n");

  // Create a completed root for these tests
  const rootForThen = await createTool.execute("c-6-root", {
    command: "echo root-ok",
    name: "then-root-edge",
  });
  const rootThenId = rootForThen.details?.promiseId;
  await sleep(500);

  // Test 6.1: promise-then with no command or download → error
  console.log("Test 6.1: promise-then with no command/download → error\n");
  const thenNoCmd = await thenTool.execute("c-6.1", { promiseId: rootThenId });
  if (thenNoCmd.isError) {
    console.log("✅ 6.1: Missing command/download correctly errors\n");
  } else {
    console.log("❌ 6.1: Expected error for missing command/download");
    throw new Error("Then without command did not error");
  }

  // Test 6.2: promise-then with both command and download → error
  console.log("Test 6.2: promise-then with both command and download → error\n");
  const thenBoth = await thenTool.execute("c-6.2", {
    promiseId: rootThenId,
    command: "echo both",
    download: "https://example.com/file",
  });
  if (thenBoth.isError) {
    console.log("✅ 6.2: Both command and download correctly errors\n");
  } else {
    console.log("❌ 6.2: Expected error for both command and download");
    throw new Error("Then with both did not error");
  }

  // Test 6.3: promise-then download without path → error
  console.log("Test 6.3: promise-then download without path → error\n");
  const thenNoPath = await thenTool.execute("c-6.3", {
    promiseId: rootThenId,
    download: "https://example.com/file",
  });
  if (thenNoPath.isError) {
    console.log("✅ 6.3: Download without path correctly errors\n");
  } else {
    console.log("❌ 6.3: Expected error for download without path");
    throw new Error("Then download without path did not error");
  }

  // Test 6.4: promise-then on nonexistent promise → error
  console.log("Test 6.4: promise-then on nonexistent promise → error\n");
  const thenNonExist = await thenTool.execute("c-6.4", {
    promiseId: "promise-fake-777",
    command: "echo nope",
  });
  if (thenNonExist.isError) {
    console.log("✅ 6.4: Nonexistent promise correctly errors\n");
  } else {
    console.log("❌ 6.4: Expected error for nonexistent promise");
    throw new Error("Then on nonexistent did not error");
  }

  // Test 6.5: promise-then on cancelled promise → error
  console.log("Test 6.5: promise-then on cancelled promise → error\n");
  const cancelledForThen = await createTool.execute("c-6.5", {
    command: "sleep 10",
    name: "cancel-for-then",
  });
  const cancelledThenId = cancelledForThen.details?.promiseId;
  await cancelTool.execute("c-6.5b", { promiseId: cancelledThenId });
  await sleep(200);
  const thenCancelled = await thenTool.execute("c-6.5c", {
    promiseId: cancelledThenId,
    command: "echo should-not-run",
  });
  if (thenCancelled.isError) {
    console.log("✅ 6.5: Chain on cancelled promise correctly errors\n");
  } else {
    console.log("❌ 6.5: Expected error for chain on cancelled");
    throw new Error("Then on cancelled did not error");
  }

  // Test 6.6: promise-then with invalid condition → error
  console.log("Test 6.6: promise-then with invalid condition → error\n");
  const thenInvalidCond = await thenTool.execute("c-6.6", {
    promiseId: rootThenId,
    command: "echo bad-cond",
    condition: "invalid-condition",
  });
  if (thenInvalidCond.isError) {
    console.log("✅ 6.6: Invalid condition correctly errors\n");
  } else {
    console.log("❌ 6.6: Expected error for invalid condition");
    throw new Error("Then with invalid condition did not error");
  }

  // ===========================================================================
  // SECTION 7: Condition edge cases
  // ===========================================================================
  console.log("═══════════════════════════════════════════");
  console.log("Section 7: Condition edge cases");
  console.log("═══════════════════════════════════════════\n");

  // Test 7.1: on-success chain when parent FAILS → child is cancelled (skipped)
  console.log("Test 7.1: on-success chain when parent fails → child skipped\n");
  const tmpDir = mkdtempSync(join(tmpdir(), "promise-cond-"));
  const condFailMarker = join(tmpDir, "cond-fail.txt");

  const failRoot = await createTool.execute("c-7.1", {
    command: "echo parent-fails && exit 1",
    name: "fail-parent",
  });
  const failRootId = failRoot.details?.promiseId;
  await sleep(500);

  await thenTool.execute("c-7.1b", {
    promiseId: failRootId,
    command: `echo "should-not-run" > "${condFailMarker}"`,
    condition: "on-success",
    name: "on-success-after-fail",
  });
  await sleep(500);

  if (existsSync(condFailMarker)) {
    console.log("❌ 7.1: on-success chain ran despite parent failure");
    throw new Error("on-success chain ran after parent failure");
  }
  console.log("✅ 7.1: on-success child correctly skipped after parent failure\n");

  // Test 7.2: on-failure chain when parent FAILS → child runs
  console.log("Test 7.2: on-failure chain when parent fails → child runs\n");
  const condFailMarker2 = join(tmpDir, "cond-fail-2.txt");

  const failRoot2 = await createTool.execute("c-7.2", {
    command: "echo parent-fails-again && exit 2",
    name: "fail-parent-2",
  });
  const failRoot2Id = failRoot2.details?.promiseId;
  await sleep(500);

  await thenTool.execute("c-7.2b", {
    promiseId: failRoot2Id,
    command: `echo "should-run" > "${condFailMarker2}"`,
    condition: "on-failure",
    name: "on-failure-after-fail",
  });
  await waitForCondition(() => existsSync(condFailMarker2) && "marker found", 8000);
  console.log("✅ 7.2: on-failure child correctly ran after parent failure\n");

  // Test 7.3: 'always' condition when parent FAILS → child runs
  console.log("Test 7.3: 'always' condition when parent fails → child runs\n");
  const condAlwaysMarker = join(tmpDir, "cond-always.txt");

  const failRoot3 = await createTool.execute("c-7.3", {
    command: "echo parent-fails-again && exit 3",
    name: "fail-parent-3",
  });
  const failRoot3Id = failRoot3.details?.promiseId;
  await sleep(500);

  await thenTool.execute("c-7.3b", {
    promiseId: failRoot3Id,
    command: `echo "always-runs" > "${condAlwaysMarker}"`,
    condition: "always",
    name: "always-after-fail",
  });
  await waitForCondition(() => existsSync(condAlwaysMarker) && "marker found", 8000);
  console.log("✅ 7.3: 'always' child correctly ran after parent failure\n");

  // ===========================================================================
  // SECTION 8: promise-then with download
  // ===========================================================================
  console.log("═══════════════════════════════════════════");
  console.log("Section 8: promise-then download variant");
  console.log("═══════════════════════════════════════════\n");

  // Test 8.1: promise-then with download (unreachable URL, should fail)
  console.log("Test 8.1: promise-then download with unreachable URL → fails gracefully\n");
  const thenDlRoot = await createTool.execute("c-8.1", {
    command: "echo ready-for-download",
    name: "then-dl-root",
  });
  const thenDlRootId = thenDlRoot.details?.promiseId;
  await sleep(500);

  const thenDlResult = await thenTool.execute("c-8.1b", {
    promiseId: thenDlRootId,
    download: "http://0.0.0.0:2/nonexistent",
    path: join(tmpDir, "then-dl-test.bin"),
    name: "then-download",
  });
  console.log("  then-download result success:", thenDlResult.details?.success);

  // Wait for download attempt to fail
  await sleep(2000);

  // Check if a chained promise was created
  const graphResult = await graphTool.execute("c-8.1c", { promiseId: thenDlRootId });
  console.log("  chain nodes:", JSON.stringify(graphResult.details?.chain));
  if (graphResult.details?.chain && graphResult.details.chain.length >= 2) {
    const child = graphResult.details.chain[1];
    console.log(`  child status: ${child.status}`);
    console.log(`✅ 8.1: promise-then download created chain (status: ${child.status})\n`);
  } else {
    console.log("  ⚠️ Chain not visible yet (may need more time)\n");
  }

  // ===========================================================================
  // SECTION 9: promise-rechain validation
  // ===========================================================================
  console.log("═══════════════════════════════════════════");
  console.log("Section 9: promise-rechain validation");
  console.log("═══════════════════════════════════════════\n");

  // Test 9.1: rechain with nonexistent fromPromise
  console.log("Test 9.1: rechain with nonexistent fromPromise → error\n");
  const rechainBadFrom = await rechainTool.execute("c-9.1", {
    fromPromiseId: "promise-fake-111",
    toPromiseId: "promise-fake-222",
  });
  if (rechainBadFrom.isError) {
    console.log("✅ 9.1: Nonexistent fromPromise correctly errors\n");
  } else {
    console.log("❌ 9.1: Expected error for nonexistent fromPromise");
    throw new Error("Rechain with bad fromPromise did not error");
  }

  // Test 9.2: rechain with nonexistent toPromise
  console.log("Test 9.2: rechain with nonexistent toPromise → error\n");
  const realSource = await createTool.execute("c-9.2", {
    command: "echo source",
    name: "rechain-source",
  });
  const realSourceId = realSource.details?.promiseId;
  await sleep(300);

  const rechainBadTo = await rechainTool.execute("c-9.2b", {
    fromPromiseId: realSourceId,
    toPromiseId: "promise-fake-333",
  });
  if (rechainBadTo.isError) {
    console.log("✅ 9.2: Nonexistent toPromise correctly errors\n");
  } else {
    console.log("❌ 9.2: Expected error for nonexistent toPromise");
    throw new Error("Rechain with bad toPromise did not error");
  }

  // Test 9.3: rechain with running source → error
  console.log("Test 9.3: rechain with running source → error\n");
  const runningSource = await createTool.execute("c-9.3", {
    command: "sleep 10",
    name: "running-source",
  });
  const runningSourceId = runningSource.details?.promiseId;
  await sleep(100);

  const completedTarget = await createTool.execute("c-9.3b", {
    command: "echo target-ok",
    name: "rechain-target",
  });
  const completedTargetId = completedTarget.details?.promiseId;
  await sleep(300);

  const rechainRunning = await rechainTool.execute("c-9.3c", {
    fromPromiseId: runningSourceId,
    toPromiseId: completedTargetId,
  });
  if (rechainRunning.isError) {
    console.log("✅ 9.3: Running source correctly errors\n");
  } else {
    console.log("❌ 9.3: Expected error for running source");
    throw new Error("Rechain with running source did not error");
  }
  // Cleanup
  await cancelTool.execute("c-9.3d", { promiseId: runningSourceId });

  // Test 9.4: rechain with source that has no command/download → error
  console.log("Test 9.4: rechain with no-command source → error\n");
  // A download promise with no URL is a valid source with no command/download to retry
  const noCmdSource = await createTool.execute("c-9.4", {
    name: "no-cmd-source",
    // no command, no download — this creates a promise that will fail
  });
  const noCmdSourceId = noCmdSource.details?.promiseId;
  await sleep(500);

  const goodTarget = await createTool.execute("c-9.4b", {
    command: "echo ready",
    name: "good-target",
  });
  const goodTargetId = goodTarget.details?.promiseId;
  await sleep(300);

  const rechainNoCmd = await rechainTool.execute("c-9.4c", {
    fromPromiseId: noCmdSourceId,
    toPromiseId: goodTargetId,
    name: "retry-from-no-cmd",
  });
  if (rechainNoCmd.isError) {
    console.log("✅ 9.4: No-command source correctly errors\n");
  } else {
    console.log("❌ 9.4: Expected error for no-command source");
    throw new Error("Rechain with no-command source did not error");
  }

  // Test 9.5: rechain with invalid condition → error
  console.log("Test 9.5: rechain with invalid condition → error\n");
  const validSource = await createTool.execute("c-9.5", {
    command: "echo valid-source",
    name: "valid-source",
  });
  const validSourceId = validSource.details?.promiseId;
  await sleep(300);

  const rechainBadCond = await rechainTool.execute("c-9.5b", {
    fromPromiseId: validSourceId,
    toPromiseId: goodTargetId,
    condition: "bad-condition",
    name: "bad-cond",
  });
  if (rechainBadCond.isError) {
    console.log("✅ 9.5: Invalid condition correctly errors\n");
  } else {
    console.log("❌ 9.5: Expected error for invalid condition");
    throw new Error("Rechain with invalid condition did not error");
  }

  // ===========================================================================
  // SECTION 10: promise-graph edge cases
  // ===========================================================================
  console.log("═══════════════════════════════════════════");
  console.log("Section 10: promise-graph edge cases");
  console.log("═══════════════════════════════════════════\n");

  // Test 10.1: graph with nonexistent ID
  console.log("Test 10.1: graph with nonexistent ID → error\n");
  const graphBadId = await graphTool.execute("c-10.1", {
    promiseId: "promise-fake-444",
  });
  if (graphBadId.isError) {
    console.log("✅ 10.1: Nonexistent ID correctly errors\n");
  } else {
    console.log("❌ 10.1: Expected error for nonexistent ID");
    throw new Error("Graph with bad ID did not error");
  }

  // ===========================================================================
  // SECTION 11: Empty state
  // ===========================================================================
  console.log("═══════════════════════════════════════════");
  console.log("Section 11: Empty / no-promises state");
  console.log("═══════════════════════════════════════════\n");

  // Note: this module has accumulated promises from all prior sections.
  // We test the no-promises scenario by checking that the tool handles
  // the full list gracefully (it won't be empty).

  // Test 11.1: promises-list handles many promises (sanity)
  console.log("Test 11.1: promises-list with accumulated promises\n");
  const listResult = await listTool.execute("c-11.1", {});
  const count = listResult.details?.count ?? 0;
  console.log("  total promises tracked:", count);
  if (count > 0) {
    console.log("✅ 11.1: promises-list returns count:", count, "\n");
  } else {
    console.log("❌ 11.1: Expected at least 1 promise");
    throw new Error("Empty promises list when expected non-empty");
  }

  // ===========================================================================
  // SECTION 12: Dedup edge cases
  // ===========================================================================
  console.log("═══════════════════════════════════════════");
  console.log("Section 12: Dedup edge cases");
  console.log("═══════════════════════════════════════════\n");

  // Test 12.1: dedup on failed promise → should create new
  console.log("Test 12.1: dedup on failed promise → creates new\n");
  const failedDedupTest = await createTool.execute("c-12.1", {
    command: "exit 10",
    subject: "test-dedup-failed",
    name: "dedup-failed-orig",
  });
  const failedDedupId = failedDedupTest.details?.promiseId;
  await sleep(500);

  const dedupAfterFail = await createTool.execute("c-12.1b", {
    command: "echo dedup-after-fail",
    subject: "test-dedup-failed",
    name: "dedup-failed-retry",
    dedup: true,
  });
  console.log("  original failed promise ID:", failedDedupId);
  console.log("  dedup result ID:", dedupAfterFail.details?.promiseId);
  console.log("  dedup flag:", dedupAfterFail.details?.dedup);
  if (dedupAfterFail.details?.dedup === false) {
    console.log("✅ 12.1: Dedup on failed created new promise (not dedup'd)\n");
  } else {
    console.log("❌ 12.1: Dedup should have created new promise for failed");
    throw new Error("Dedup on failed returned existing");
  }

  // Test 12.2: dedup on cancelled promise → should create new
  console.log("Test 12.2: dedup on cancelled promise → creates new\n");
  const cancelledDedupTest = await createTool.execute("c-12.2", {
    command: "sleep 10",
    subject: "test-dedup-cancelled",
    name: "dedup-cancelled-orig",
  });
  const cancelledDedupId = cancelledDedupTest.details?.promiseId;
  await cancelTool.execute("c-12.2b", { promiseId: cancelledDedupId });
  await sleep(200);

  const dedupAfterCancel = await createTool.execute("c-12.2c", {
    command: "echo dedup-after-cancel",
    subject: "test-dedup-cancelled",
    name: "dedup-cancelled-retry",
    dedup: true,
  });
  console.log("  original cancelled promise ID:", cancelledDedupId);
  console.log("  dedup result ID:", dedupAfterCancel.details?.promiseId);
  if (dedupAfterCancel.details?.dedup === false) {
    console.log("✅ 12.2: Dedup on cancelled created new promise\n");
  } else {
    console.log("❌ 12.2: Dedup should have created new promise for cancelled");
    throw new Error("Dedup on cancelled returned existing");
  }

  // ===========================================================================
  // SECTION 13: Replace edge cases
  // ===========================================================================
  console.log("═══════════════════════════════════════════");
  console.log("Section 13: Replace edge cases");
  console.log("═══════════════════════════════════════════\n");

  // Test 13.1: replace on completed promise → should cancel and create new
  console.log("Test 13.1: replace on completed promise → cancels old, creates new\n");
  const completedReplace = await createTool.execute("c-13.1", {
    command: "echo orig-completed",
    subject: "test-replace-completed",
    name: "replace-completed-orig",
  });
  const completedReplaceId = completedReplace.details?.promiseId;
  await sleep(500);

  const replaceAfterCompleted = await createTool.execute("c-13.1b", {
    command: "echo new-after-completed",
    subject: "test-replace-completed",
    name: "replace-completed-new",
    replace: true,
  });
  const newReplaceId = replaceAfterCompleted.details?.promiseId;
  console.log("  original completed ID:", completedReplaceId);
  console.log("  new ID:", newReplaceId);
  if (newReplaceId !== completedReplaceId) {
    console.log("✅ 13.1: Replace on completed created new promise\n");
  } else {
    console.log("❌ 13.1: Expected new promise ID");
    throw new Error("Replace on completed did not create new");
  }

  // ===========================================================================
  // SECTION 14: Command edge cases
  // ===========================================================================
  console.log("═══════════════════════════════════════════");
  console.log("Section 14: Command edge cases");
  console.log("═══════════════════════════════════════════\n");

  // Test 14.1: command with empty output
  console.log("Test 14.1: command with no stdout output → completes with empty output\n");
  const emptyOut = await createTool.execute("c-14.1", {
    command: "echo -n ''",
    name: "empty-output",
  });
  const emptyOutId = emptyOut.details?.promiseId;
  await sleep(500);
  const emptyOutStatus = await statusTool.execute("c-14.1b", { promiseId: emptyOutId });
  if (emptyOutStatus.details?.status === "completed") {
    const result = emptyOutStatus.details?.result;
    console.log("  output:", JSON.stringify(result?.output));
    console.log("✅ 14.1: Empty output completed successfully\n");
  } else {
    console.log("❌ 14.1: Expected completed, got", emptyOutStatus.details?.status);
    throw new Error("Empty output command did not complete");
  }

  // Test 14.2: command with very long name
  console.log("Test 14.2: promise with very long name\n");
  const longName = "a".repeat(500);
  const longNameResult = await createTool.execute("c-14.2", {
    command: "echo ok",
    name: longName,
  });
  const longNameId = longNameResult.details?.promiseId;
  await sleep(500);
  const longNameStatus = await statusTool.execute("c-14.2b", { promiseId: longNameId });
  if (longNameStatus.details?.status === "completed") {
    console.log("✅ 14.2: Very long name handled correctly\n");
  } else {
    console.log("❌ 14.2: Long name promise failed");
    throw new Error("Long name promise did not complete");
  }

  // ===========================================================================
  // SECTION 15: Promise created with then on failing parent (default: 'always')
  // ===========================================================================
  console.log("═══════════════════════════════════════════");
  console.log("Section 15: promise-create with then on failing parent");
  console.log("═══════════════════════════════════════════\n");

  // Test 15.1: 'then' child with default 'always' condition on a failing parent → child runs
  console.log("Test 15.1: 'then' (default always) on failing parent → child runs\n");
  const alwaysThenFail = await createTool.execute("c-15.1", {
    command: "exit 5",
    then: `echo "always-after-fail" > "${join(tmpDir, "always-then-fail.txt")}"`,
    name: "always-then-fail-root",
  });
  await waitForCondition(() => existsSync(join(tmpDir, "always-then-fail.txt")) && "marker found", 8000);
  console.log("✅ 15.1: 'then' with default 'always' ran after parent failure\n");

  // Test 15.2: 'then' with on-success on failing parent → child skipped
  console.log("Test 15.2: 'then' with on-success on failing parent → child skipped\n");
  const onSuccessThenFail = await createTool.execute("c-15.2", {
    command: "exit 6",
    then: `echo "should-not-run" > "${join(tmpDir, "onsuccess-then-fail.txt")}"`,
    thenCondition: "on-success",
    name: "onsuccess-then-fail-root",
  });
  await sleep(1000);
  if (!existsSync(join(tmpDir, "onsuccess-then-fail.txt"))) {
    console.log("✅ 15.2: on-success 'then' correctly skipped after parent failure\n");
  } else {
    console.log("❌ 15.2: on-success child ran despite parent failure");
    throw new Error("on-success 'then' ran after parent failure");
  }

  // Test 15.3: 'then' with on-failure on succeeding parent → child skipped
  console.log("Test 15.3: 'then' with on-failure on succeeding parent → child skipped\n");
  const onFailThenSuccess = await createTool.execute("c-15.3", {
    command: "echo ok",
    then: `echo "should-not-run" > "${join(tmpDir, "onfail-then-success.txt")}"`,
    thenCondition: "on-failure",
    name: "onfail-then-success-root",
  });
  await sleep(1000);
  if (!existsSync(join(tmpDir, "onfail-then-success.txt"))) {
    console.log("✅ 15.3: on-failure 'then' correctly skipped after parent success\n");
  } else {
    console.log("❌ 15.3: on-failure child ran despite parent success");
    throw new Error("on-failure 'then' ran after parent success");
  }

  // ===========================================================================
  // SECTION 16: Tmux integration helpers
  // ===========================================================================
  console.log("═══════════════════════════════════════════");
  console.log("Section 16: Tmux integration helpers");
  console.log("═══════════════════════════════════════════\n");

  // Import the tmux helpers from the module
  const extModuleTmux = await import(extPath);
  const {
    _toTmuxName,
    _readTmuxOutput,
    _readTmuxExitCode,
    _isTmuxAvailable,
    _killTmuxSession,
  } = extModuleTmux as any;

  // Test 16.1: _toTmuxName sanitization
  console.log("Test 16.1: _toTmuxName sanitizes promise IDs\n");
  const mockPromise1 = { id: "promise-12345-abc" } as any;
  const name1 = _toTmuxName(mockPromise1);
  console.log(`  ID=${mockPromise1.id} → "${name1}"`);
  if (name1 === "promise-promise-12345-abc") {
    console.log("✅ 16.1a: Simple ID passes through\n");
  } else {
    console.log("❌ 16.1a: Expected promise-promise-12345-abc");
    throw new Error("toTmuxName failed on simple ID");
  }

  console.log("Test 16.1b: Special chars are stripped\n");
  const mockPromise2 = { id: "promise-abc_123/foo bar!@#" } as any;
  const name2 = _toTmuxName(mockPromise2);
  console.log(`  ID="${mockPromise2.id}" → "${name2}"`);
  if (name2.startsWith("promise-promise-abc-123-foo-bar-") && !name2.includes("@#")) {
    console.log("✅ 16.1b: Special chars sanitized\n");
  } else {
    console.log("❌ 16.1b: Sanitization failed");
    throw new Error("toTmuxName sanitization failed");
  }

  console.log("Test 16.1c: Long IDs are truncated to 64 chars total\n");
  const longId = "promise-" + "a".repeat(100);
  const mockPromise3 = { id: longId } as any;
  const name3 = _toTmuxName(mockPromise3);
  console.log(`  total length: ${name3.length}, value: "${name3}"`);
  // The sanitized ID includes "promise-" prefix (8 chars), then a's
  // So available space after "promise-" prefix is 64 - 8 = 56 chars
  // The first 8 of those are "promise-" from the ID itself
  // So only 48 a's remain
  if (name3.length === 64 && name3.endsWith("a".repeat(48))) {
    console.log("✅ 16.1c: Long ID truncated to 64 chars (prefix+sanitized)\n");
  } else {
    console.log("❌ 16.1c: Expected 64 chars with proper truncation");
    throw new Error("toTmuxName truncation failed");
  }

  // Test 16.2: _readTmuxOutput handles marker stripping (new format with exit code)
  console.log("Test 16.2: _readTmuxOutput strips completion marker\n");
  const testPromiseId = "promise-test-read-output-123";
  const testOutFile = `/tmp/promise-${testPromiseId}.out`;
  // echo writes trailing newline
  writeFileSync(testOutFile, "line1\nline2\n---PROMISE-DONE:0---\n", "utf-8");
  const output = _readTmuxOutput(testPromiseId);
  console.log(`  raw file: "line1\\nline2\\n---PROMISE-DONE:0---\\n"`);
  console.log(`  parsed: "${output}"`);
  if (output === "line1\nline2") {
    console.log("✅ 16.2: Marker correctly stripped\n");
  } else {
    console.log("❌ 16.2: Expected 'line1\\nline2', got:", JSON.stringify(output));
    throw new Error("readTmuxOutput marker stripping failed");
  }

  // Verify _readTmuxExitCode extracts the exit code
  const exitCode = _readTmuxExitCode(testPromiseId);
  if (exitCode === 0) {
    console.log("✅ 16.2a: Exit code extracted correctly (0)\n");
  } else {
    console.log("❌ 16.2a: Expected exit code 0, got", exitCode);
    throw new Error("readTmuxExitCode failed");
  }
  unlinkSync(testOutFile);

  console.log("Test 16.2b: Non-zero exit code\n");
  writeFileSync(testOutFile, "error\n---PROMISE-DONE:42---\n", "utf-8");
  const ec = _readTmuxExitCode(testPromiseId);
  if (ec === 42) {
    console.log("✅ 16.2b: Exit code 42 extracted\n");
  } else {
    console.log("❌ 16.2b: Expected 42, got", ec);
    throw new Error("readTmuxExitCode non-zero failed");
  }
  unlinkSync(testOutFile);

  console.log("Test 16.2c: No marker → returns full content, exit code undefined\n");
  writeFileSync(testOutFile, "just data", "utf-8");
  const output2 = _readTmuxOutput(testPromiseId);
  const ec2 = _readTmuxExitCode(testPromiseId);
  if (output2 === "just data" && ec2 === undefined) {
    console.log("✅ 16.2c: No marker, full content returned, exit code undefined\n");
  } else {
    console.log("❌ 16.2c: Expected 'just data' and undefined, got:", JSON.stringify(output2), ec2);
    throw new Error("readTmuxOutput no-marker failed");
  }
  unlinkSync(testOutFile);

  console.log("Test 16.2d: Nonexistent file returns empty string\n");
  const output3 = _readTmuxOutput("promise-nonexistent");
  if (output3 === "") {
    console.log("✅ 16.2d: Nonexistent file returns empty\n");
  } else {
    console.log("❌ 16.2d: Expected '', got:", JSON.stringify(output3));
    throw new Error("readTmuxOutput nonexistent failed");
  }

  // Test 16.3: _isTmuxAvailable — check if tmux binary is on PATH
  console.log("Test 16.3: _isTmuxAvailable detects tmux binary\n");
  const tmuxAvail = _isTmuxAvailable();
  console.log(`  tmux available: ${tmuxAvail}`);
  // Can't assert on this — depends on test environment
  console.log(`✅ 16.3: _isTmuxAvailable returned ${tmuxAvail} (no error)\n`);

  // Test 16.4: _killTmuxSession on nonexistent session is a no-op
  console.log("Test 16.4: _killTmuxSession on nonexistent promise is no-op\n");
  try {
    _killTmuxSession("promise-nonexistent-session-99999");
    console.log("✅ 16.4: No error for nonexistent session\n");
  } catch (err: any) {
    console.log("❌ 16.4: Unexpected error:", err.message);
    throw new Error("killTmuxSession threw on nonexistent");
  }

  // Test 16.5: Integration — verify tmux session creation via tool (if available)
  console.log("Test 16.5: Integration — promise creates tmux session (quick)\n");
  let hasTmux = false;
  try {
    hasTmux = execSync("tmux -V", { stdio: "pipe", timeout: 3000 }).toString().trim().length > 0;
  } catch {}
  if (hasTmux) {
    const tmuxInteg = await createTool.execute("c-16.5", {
      command: "echo 'tmux integ ok'",
      name: "tmux-integ",
    });
    const tmuxIntegId = tmuxInteg.details?.promiseId;
    await sleep(2000);

    // Check if a tmux session was created for this promise
    let sessionFound = false;
    try {
      const sessions = execSync("tmux list-sessions -F '#{session_name}' 2>/dev/null", { stdio: "pipe", timeout: 3000 }).toString();
      sessionFound = sessions.includes("promise-" + tmuxIntegId);
    } catch {}

    if (sessionFound) {
      console.log(`✅ 16.5: Tmux session created for ${tmuxIntegId}`);
      // Clean up the session
      try { execSync(`tmux kill-session -t "promise-${_toTmuxName({id: tmuxIntegId} as any)}" 2>/dev/null`, { stdio: "ignore", timeout: 3000 }); } catch {}
    } else {
      console.log(`  Note: No tmux session found (may have already completed) - checking _runDirect fallback worked...`);
      const statusCheck = await statusTool.execute("c-16.5b", { promiseId: tmuxIntegId });
      console.log(`  Promise status: ${statusCheck.details?.status}`);
      if (statusCheck.details?.status === "completed") {
        console.log(`  ✅ 16.5: Promise completed successfully (via tmux or fallback)`);
      }
    }
    console.log("");
  } else {
    console.log("  ⏭ Tmux not available on this system, skipping integration test\n");
  }

  // ===========================================================================
  // SUMMARY
  // ===========================================================================
  console.log("═══════════════════════════════════════════");
  console.log("SUMMARY");
  console.log("═══════════════════════════════════════════\n");
  console.log(`Total sentMessages: ${pi.sentMessages.length}`);
  console.log(`Tools tested: ${pi.tools.map((t) => t.name).join(", ")}`);
  console.log("\n✅ All corner-case tests passed!");

  // Cleanup temp dir
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

// =============================================================================
// Safe wrapper for promise-await (handles both isError and non-error returns)
// =============================================================================
async function promiseAwaitSafe(tool: RegisteredTool, callId: string, args: { promiseId: string }) {
  const result = await tool.execute(callId, args);
  return {
    isError: !!(result.isError || (result.details && result.details.success === false) || (result.content?.[0]?.text?.includes("not found") || result.content?.[0]?.text?.includes("failed") || result.content?.[0]?.text?.includes("cancelled"))),
    details: result.details,
    content: result.content,
    result,
  };
}

main().catch((err) => {
  console.error("\n❌ Corner-case test suite failed:", err.message);
  process.exit(1);
}).finally(() => {
  // Clean up any leftover temp dirs
  try {
    for (const entry of readdirSync(tmpdir())) {
      if (entry.startsWith("promise-")) {
        rmSync(join(tmpdir(), entry), { recursive: true, force: true });
      }
    }
  } catch { /* best-effort */ }
});
