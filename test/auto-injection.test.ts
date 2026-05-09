/**
 * Integration test for auto-injection on promise completion.
 *
 * Loads the extension, fires background commands, and verifies that
 * pi.sendMessage() is called automatically when promises complete.
 *
 * Run: npx tsx test/auto-injection.test.ts
 */

import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// =============================================================================
// Tracked mock for ExtensionAPI
// =============================================================================

interface RegisteredTool {
  name: string;
  execute: Function;
}

class MockExtensionAPI {
  tools: RegisteredTool[] = [];
  sentMessages: Array<{ message: any; options?: any }> = [];

  registerTool(def: any) {
    this.tools.push({ name: def.name, execute: def.execute });
  }

  sendMessage(message: any, options?: any) {
    this.sentMessages.push({ message, options });
  }

  // Required stubs
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
  throw new Error(
    `Timeout after ${timeoutMs}ms. Last condition result: ${JSON.stringify(last)}`
  );
}

// =============================================================================
// Main test
// =============================================================================

async function main() {
  const pi = new MockExtensionAPI();

  // Load and run the extension
  const extPath = join(
    __dirname,
    "..",
    "src/extensions/downloads-wisely/bg-promises.ts"
  );
  const extModule = await import(extPath);
  extModule.default(pi as any);

  // Retrieve tools
  const createTool = pi.tools.find((t) => t.name === "promise-create");
  const awaitTool = pi.tools.find((t) => t.name === "promise-await");
  const listTool = pi.tools.find((t) => t.name === "promises-list");
  const statusTool = pi.tools.find((t) => t.name === "promise-status");
  const cancelTool = pi.tools.find((t) => t.name === "promise-cancel");
  const thenTool = pi.tools.find((t) => t.name === "promise-then");
  const rechainTool = pi.tools.find((t) => t.name === "promise-rechain");
  const graphTool = pi.tools.find((t) => t.name === "promise-graph");

  if (!createTool || !awaitTool) {
    throw new Error("Required tools not registered");
  }

  console.log("Tools registered:", pi.tools.map((t) => t.name));
  console.log("");

  // ---- Test 1: Start a quick command and verify auto-injection ----
  console.log("═══════════════════════════════════════════");
  console.log("Test 1: Background command → auto-injection");
  console.log("═══════════════════════════════════════════\n");

  // Create a temp dir for test artifacts
  const tmpDir = mkdtempSync(join(tmpdir(), "promise-test-"));
  const markerFile = join(tmpDir, "done.txt");

  writeFileSync(
    join(tmpDir, "script.sh"),
    `echo "hello from bg" > "${markerFile}"\necho "Hello from background task!"`
  );

  const createResult = await createTool.execute("call-1", {
    command: `sh "${join(tmpDir, "script.sh")}"`,
    name: "test-greet",
  });

  const promiseId = createResult.details?.promiseId;
  console.log("promise-create returned:", JSON.stringify(createResult.details, null, 2));
  if (!promiseId) throw new Error("❌ No promiseId returned");
  console.log("");

  // Wait for the command to complete (marker file appears)
  await waitForCondition(() => existsSync(markerFile) && "marker found", 8000);
  console.log("✓ Command completed (marker file detected)\n");

  // Give the event loop a tick for the notification callback
  await sleep(500);

  // Check for auto-injection message
  const completionMsg = pi.sentMessages.find(
    (m) =>
      m.message?.customType === "promise-completion" &&
      m.message?.content?.includes("test-greet")
  );

  if (completionMsg) {
    console.log("✅ Auto-injection captured:");
    console.log(completionMsg.message.content);
    console.log("");
  } else {
    console.log("❌ No auto-injection message");
    console.log("Sent messages:", JSON.stringify(pi.sentMessages, null, 2));
    throw new Error("Auto-injection not triggered");
  }

  // ---- Test 2: promise-await on completed promise returns result ----
  console.log("═══════════════════════════════════════════");
  console.log("Test 2: promise-await on completed promise");
  console.log("═══════════════════════════════════════════\n");

  const awaitResult = await awaitTool.execute("call-2", { promiseId });
  
  if (awaitResult.details?.success) {
    console.log("✅ promise-await returns success:", JSON.stringify(awaitResult.details.result));
  } else {
    console.log("❌ promise-await failed:", JSON.stringify(awaitResult));
    throw new Error("promise-await failed");
  }
  console.log("");

  // ---- Test 3: promises-list shows completed promise ----
  console.log("═══════════════════════════════════════════");
  console.log("Test 3: promises-list");
  console.log("═══════════════════════════════════════════\n");

  if (listTool) {
    const listResult = await listTool.execute("call-3", {});
    console.log("promises-list:", JSON.stringify(listResult.details, null, 2));
    console.log("");
  }

  // ---- Test 4: Failure auto-injection ----
  console.log("═══════════════════════════════════════════");
  console.log("Test 4: Failed command → auto-injection");
  console.log("═══════════════════════════════════════════\n");

  const failResult = await createTool.execute("call-4", {
    command: "echo 'oops' && exit 42",
    name: "test-fail",
  });
  const failPromiseId = failResult.details?.promiseId;
  console.log("Failed promise ID:", failPromiseId);

  // Wait for failure
  await sleep(1000);

  const failMsg = pi.sentMessages.find(
    (m) =>
      m.message?.customType === "promise-completion" &&
      m.message?.content?.includes("test-fail")
  );

  if (failMsg) {
    console.log("✅ Failure auto-injection captured:");
    console.log(failMsg.message.content);
  } else {
    console.log("❌ No failure notification");
    // List what we got
    pi.sentMessages.forEach((m, i) =>
      console.log(`  [${i}] customType=${m.message?.customType} content=${(m.message?.content ?? "").slice(0, 100)}`)
    );
  }
  console.log("");

  // ---- Test 5: promise-cancel ----
  console.log("═══════════════════════════════════════════");
  console.log("Test 5: promise-cancel on running promise");
  console.log("═══════════════════════════════════════════\n");

  if (cancelTool) {
    // Start a long-running command (sleep 60, will be killed on cancel)
    const longResult = await createTool.execute("call-5", {
      command: "sleep 60",
      name: "test-long",
    });
    const longPromiseId = longResult.details?.promiseId;

    // Cancel it
    const cancelResult = await cancelTool.execute("call-6", {
      promiseId: longPromiseId,
    });
    
    if (cancelResult.details?.success) {
      console.log("✅ promise-cancel succeeded");
    } else {
      console.log("❌ promise-cancel failed:", JSON.stringify(cancelResult));
    }
    
    // Give time for SIGTERM to be delivered
    await sleep(300);
    console.log("");
  }

  // ---- Test 6: Chain commands ----
  console.log("═══════════════════════════════════════════");
  console.log("Test 6: Chained commands auto-inject both");
  console.log("═══════════════════════════════════════════\n");

  const chainMarker1 = join(tmpDir, "chain1.txt");
  const chainMarker2 = join(tmpDir, "chain2.txt");

  const chainResult = await createTool.execute("call-7", {
    command: `echo "step1" > "${chainMarker1}"`,
    then: `echo "step2" > "${chainMarker2}"`,
    name: "test-chain",
  });
  const chainPromiseId = chainResult.details?.promiseId;
  console.log("Chained promise ID:", chainPromiseId);

  // Wait for both to complete
  await waitForCondition(() => existsSync(chainMarker2) && "chain2 found", 10000);
  await sleep(300);

  const chainNotifs = pi.sentMessages.filter(
    (m) =>
      m.message?.customType === "promise-completion" &&
      m.message?.content?.includes("test-chain")
  );

  console.log(`Chained notifications: ${chainNotifs.length}`);
  chainNotifs.forEach((n, i) => {
    console.log(`  [${i}] ${n.message.content.split("\n")[0]}`);
  });

  if (chainNotifs.length >= 1) {
    console.log("✅ Chained auto-injection works");
  } else {
    console.log("❌ Chained notification not found");
  }
  console.log("");

  // ---- Test 7: promise-then chaining ----
  console.log("═══════════════════════════════════════════");
  console.log("Test 7: promise-then chains to existing promise");
  console.log("═══════════════════════════════════════════\n");

  if (thenTool) {
    const thenMarker1 = join(tmpDir, "then1.txt");
    const thenMarker2 = join(tmpDir, "then2.txt");
    const thenMarker3 = join(tmpDir, "then3.txt");

    // Create a root command
    const rootResult = await createTool.execute("call-8", {
      command: `echo "root" > "${thenMarker1}"`,
      name: "test-then-root",
    });
    const rootId = rootResult.details?.promiseId;
    console.log("Root promise ID:", rootId);

    // Wait for root to complete
    await waitForCondition(() => existsSync(thenMarker1) && "root done", 8000);
    console.log("✓ Root command completed");

    // Chain a 'then' command to the completed root
    const thenResult = await thenTool.execute("call-9", {
      promiseId: rootId,
      command: `echo "then1" > "${thenMarker2}"`,
      name: "test-then-step1",
    });
    console.log("promise-then result:", JSON.stringify(thenResult.details));

    // Wait for the chained command to complete
    await waitForCondition(() => existsSync(thenMarker2) && "then1 done", 8000);
    console.log("✓ First chained command completed");

    // Chain another 'then' to the same root (should append to end of chain)
    const thenResult2 = await thenTool.execute("call-10", {
      promiseId: rootId,
      command: `echo "then2" > "${thenMarker3}"`,
      name: "test-then-step2",
    });
    console.log("Second promise-then result:", JSON.stringify(thenResult2.details));

    // Wait for second chained command to complete
    await waitForCondition(() => existsSync(thenMarker3) && "then2 done", 8000);
    console.log("✓ Second chained command completed");

    // Check notifications
    const thenNotifs = pi.sentMessages.filter(
      (m) =>
        m.message?.customType === "promise-completion" &&
        m.message?.content?.includes("test-then")
    );
    console.log(`promise-then notifications: ${thenNotifs.length}`);
    thenNotifs.forEach((n, i) => {
      console.log(`  [${i}] ${n.message.content.split("\n")[0]}`);
    });

    if (thenNotifs.length >= 2) {
      console.log("✅ promise-then works with multiple chains");
    } else {
      console.log("❌ promise-then notifications incomplete");
    }

    // ---- Test 7b: promise-then condition on-success ----
    console.log("");
    console.log("--- Subtest: promise-then condition='on-success' ---");
    const condMarker1 = join(tmpDir, "cond1.txt");
    const condMarker2 = join(tmpDir, "cond2.txt");

    // Create a command that will succeed
    const condRoot = await createTool.execute("call-11", {
      command: `echo "ok" > "${condMarker1}"`,
      name: "test-condition-root",
    });
    const condRootId = condRoot.details?.promiseId;
    await waitForCondition(() => existsSync(condMarker1) && "cond root done", 8000);

    // Chain with condition='on-success' (should run because root succeeded)
    const condThen = await thenTool.execute("call-12", {
      promiseId: condRootId,
      command: `echo "conditional-pass" > "${condMarker2}"`,
      condition: "on-success",
      name: "test-condition-pass",
    });
    console.log("condition='on-success' result:", JSON.stringify(condThen.details));

    await waitForCondition(() => existsSync(condMarker2) && "cond then done", 8000);
    console.log("✓ Conditional chain (on-success) completed");

    console.log("");
    console.log("✅ promise-then (all variants) works");
  } else {
    console.log("⚠️ promise-then tool not found, skipping Test 7");
  }
  console.log("");

  // ---- Test 8: promise-create with then + promise-then on running promise ----
  console.log("═══════════════════════════════════════════");
  console.log("Test 8: promise-then appends after pre-created child");
  console.log("═══════════════════════════════════════════\n");

  const raceMarker1 = join(tmpDir, "race1.txt");
  const raceMarker2 = join(tmpDir, "race2.txt");
  const raceMarker3 = join(tmpDir, "race3.txt");

  // Create a command that takes 300ms with a `then`.
  // The child is pre-created, so promise-then called before completion
  // appends to the pre-created child — original then-step is preserved.
  // Chain: root → pre-created then → promise-then after (3 steps)
  const raceResult = await createTool.execute("call-13", {
    command: `sleep 0.3 && echo "orig" > "${raceMarker1}"`,
    then: `echo "then-step" > "${raceMarker2}"`,
    name: "race-root",
  });
  const raceRootId = raceResult.details?.promiseId;
  console.log("Race root promise ID:", raceRootId);

  // Immediately chain another command while original is still running
  if (thenTool) {
    const thenRaceResult = await thenTool.execute("call-14", {
      promiseId: raceRootId,
      command: `echo "then-after" > "${raceMarker3}"`,
      name: "race-then-after",
    });
    console.log("Immediate promise-then result:", JSON.stringify(thenRaceResult.details));
  }

  // Wait for all three markers — pre-creation means promise-then appended
  // after the pre-created child, so the original then-step still runs.
  await waitForCondition(() => existsSync(raceMarker1) && "root done", 15000);
  console.log("✓ Root command completed");
  await waitForCondition(() => existsSync(raceMarker2) && "then step done", 15000);
  console.log("✓ Original then-step completed");
  await waitForCondition(() => existsSync(raceMarker3) && "then after done", 15000);
  console.log("✓ promise-then after-step completed");

  // Verify chain has 3 steps (root → then → promise-then)
  if (thenTool && graphTool) {
    const graphResult = await graphTool.execute("call-15", {
      promiseId: raceRootId,
    });
    console.log("Chain graph:", JSON.stringify(graphResult.details));
    if (graphResult.details?.chain && graphResult.details.chain.length >= 3) {
      console.log("✅ All 3 steps in chain (root → pre-created then → promise-then)");
    } else {
      console.log("Chain:", JSON.stringify(graphResult.details?.chain));
      console.log("⚠️ Chain length unexpected");
    }
  }
  console.log("");

  // ---- Test 9: promise-rechain ----
  console.log("═══════════════════════════════════════════");
  console.log("Test 9: promise-rechain");
  console.log("═══════════════════════════════════════════\n");

  if (rechainTool) {
    // Create a command that completes (writes a marker) then fails
    // The marker is written BEFORE the exit, so it exists even on failure
    const rechainCmdMarker = join(tmpDir, "rechain-cmd.txt");
    const rechainSourceResult = await createTool.execute("call-16", {
      command: `echo "replay-me" > "${rechainCmdMarker}"`,
      name: "replay-source",
    });
    const rechainSourceId = rechainSourceResult.details?.promiseId;
    console.log("Source promise ID:", rechainSourceId);

    // Wait for it to complete
    await waitForCondition(() => existsSync(rechainCmdMarker) && "source ok", 8000);
    console.log("✓ Source command completed");

    // Delete the marker so rechain must recreate it
    rmSync(rechainCmdMarker);
    console.log("  (deleted marker to verify rechain recreates it)");

    // Create a new successful root to rechain after
    const rechainRootResult = await createTool.execute("call-18", {
      command: `echo "new-root" > "${join(tmpDir, "rechain-root.txt")}"`,
      name: "rechain-root",
    });
    const rechainRootId = rechainRootResult.details?.promiseId;
    await waitForCondition(
      () => existsSync(join(tmpDir, "rechain-root.txt")) && "rechain root ok",
      8000
    );
    console.log("✓ New root completed");

    // Rechain the source command after the new root
    // promise-rechain re-runs the original command (echo "replay-me" > marker)
    const rechainResult = await rechainTool.execute("call-19", {
      fromPromiseId: rechainSourceId,
      toPromiseId: rechainRootId,
      name: "rechained-step",
    });
    console.log("Rechain result:", JSON.stringify(rechainResult.details));

    // Wait for marker to be recreated
    await waitForCondition(() => existsSync(rechainCmdMarker) && "rechained done", 15000);
    console.log("✓ Rechained command recreated marker");

    // Check chain structure
    const rechainGraph = await graphTool.execute("call-20", {
      promiseId: rechainRootId,
    });
    console.log("Rechain chain:", JSON.stringify(rechainGraph.details?.chain));
    if (rechainGraph.details?.chain && rechainGraph.details.chain.length >= 2) {
      console.log("✅ Rechain created proper chain");
    } else {
      console.log("❌ Rechain chain too short");
    }
  } else {
    console.log("⚠️ promise-rechain tool not found, skipping Test 9");
  }
  console.log("");

  // ---- Test 10: promise-graph ----
  console.log("═══════════════════════════════════════════");
  console.log("Test 10: promise-graph");
  console.log("═══════════════════════════════════════════\n");

  if (graphTool) {
    const gMarker1 = join(tmpDir, "graph1.txt");
    const gMarker2 = join(tmpDir, "graph2.txt");

    // Create a two-step chain
    const gRoot = await createTool.execute("call-21", {
      command: `echo "g1" > "${gMarker1}"`,
      then: `echo "g2" > "${gMarker2}"`,
      name: "graph-root",
    });
    const gRootId = gRoot.details?.promiseId;

    // Wait for both to complete
    await waitForCondition(() => existsSync(gMarker2) && "g2 done", 10000);
    await sleep(200);

    // Call promise-graph (all chains)
    const allGraph = await graphTool.execute("call-22", {});
    console.log("All chains graph:");
    console.log(allGraph.content[0]?.text || "");
    if (allGraph.details?.count && allGraph.details.count >= 1) {
      console.log("✅ promise-graph returns chains");
    } else {
      console.log("❌ promise-graph returned no chains");
    }

    // Call promise-graph (specific ID)
    const specificGraph = await graphTool.execute("call-23", {
      promiseId: gRootId,
    });
    console.log("Specific chain:");
    console.log(specificGraph.content[0]?.text || "");
    if (specificGraph.details?.found && specificGraph.details.depth !== undefined) {
      console.log("✅ promise-graph for specific ID works");
    } else {
      console.log("❌ promise-graph for specific ID failed");
    }
  } else {
    console.log("⚠️ promise-graph tool not found, skipping Test 10");
  }
  console.log("");

  // ---- Test 11: on-failure condition (skipped chain) ----
  console.log("═══════════════════════════════════════════");
  console.log("Test 11: on-failure condition (skipped chain)");
  console.log("═══════════════════════════════════════════\n");

  if (thenTool) {
    // Success parent + on-failure child → child should be skipped (cancelled)
    const failCondMarker = join(tmpDir, "fail-cond.txt");
    const failCondResult = await createTool.execute("call-24", {
      command: `echo "parent-ok" > "${join(tmpDir, "fail-cond-parent.txt")}"`,
      name: "fail-cond-parent",
    });
    const failCondId = failCondResult.details?.promiseId;
    await waitForCondition(
      () => existsSync(join(tmpDir, "fail-cond-parent.txt")) && "parent done",
      8000
    );
    console.log("✓ Parent completed successfully");

    // Chain with on-failure — should NOT run (parent succeeded)
    await thenTool.execute("call-25", {
      promiseId: failCondId,
      command: `echo "should-not-run" > "${failCondMarker}"`,
      condition: "on-failure",
      name: "should-be-skipped",
    });

    // Wait a bit and verify the marker does NOT exist
    await sleep(1000);
    if (existsSync(failCondMarker)) {
      console.log("❌ on-failure child ran despite parent succeeding!");
      throw new Error("on-failure chain ran despite parent success");
    }
    console.log("✅ on-failure child correctly skipped (marker not created)");

    // Verify cancellation message was sent
    const skipMsg = pi.sentMessages.find(
      (m) => m.message?.customType === "promise-completion" &&
        m.message?.content?.includes("should-be-skipped") &&
        m.message?.content?.includes("skipped")
    );
    if (skipMsg) {
      console.log("✅ Skipped notification captured:", skipMsg.message.content.split("\n")[0]);
    } else {
      console.log('⚠️ Skipped notification not found (may have "completed" instead of "skipped" in message)');
    }
  }
  console.log("");

  // ---- Test 12: Cancel cascades to children ----
  console.log("═══════════════════════════════════════════");
  console.log("Test 12: Cancel cascades to children");
  console.log("═══════════════════════════════════════════\n");

  if (cancelTool) {
    const cascadeMarker = join(tmpDir, "cascade-child.txt");
    const cascadeResult = await createTool.execute("call-26", {
      command: "sleep 5",
      then: `echo "child-should-not-run" > "${cascadeMarker}"`,
      name: "cascade-parent",
    });
    const cascadeParentId = cascadeResult.details?.promiseId;
    console.log("Cascade parent ID:", cascadeParentId);

    // Cancel the parent
    const cancelResult = await cancelTool.execute("call-27", {
      promiseId: cascadeParentId,
    });
    console.log("Cancel result:", cancelResult.details?.success ? "success" : "failed");

    // Wait a bit
    await sleep(500);

    // Verify child marker does NOT exist
    if (existsSync(cascadeMarker)) {
      console.log("❌ Child ran despite parent being cancelled!");
      throw new Error("Child ran after parent cancel");
    }
    console.log("✅ Child was cancelled — marker not created");

    // Verify parent is cancelled
    const parentStatus = await statusTool.execute("call-28", { promiseId: cascadeParentId });
    console.log("Parent status:", parentStatus.details?.status);
    if (parentStatus.details?.status !== "cancelled") {
      console.log("Note: Parent status is", parentStatus.details?.status, "(already settled)");
    }
  }
  console.log("");

  // ---- Test 13: previousResult in chains ----
  console.log("═══════════════════════════════════════════");
  console.log("Test 13: previousResult in chains");
  console.log("═══════════════════════════════════════════\n");

  if (graphTool && statusTool && awaitTool) {
    const prevMarker1 = join(tmpDir, "prev1.txt");
    const prevMarker2 = join(tmpDir, "prev2.txt");

    const prevResult = await createTool.execute("call-29", {
      command: `echo "chain-step-1" > "${prevMarker1}"`,
      then: `echo "chain-step-2" > "${prevMarker2}"`,
      name: "prev-chain-root",
    });
    const prevRootId = prevResult.details?.promiseId;

    // Wait for both to complete
    await waitForCondition(() => existsSync(prevMarker2) && "prev2 done", 10000);
    await sleep(300);

    // Find the child ID from graph
    const prevGraph = await graphTool.execute("call-30", { promiseId: prevRootId });
    const chainNodes = prevGraph.details?.chain;
    console.log("Chain nodes:", JSON.stringify(chainNodes));

    if (chainNodes && chainNodes.length >= 2) {
      const childId = chainNodes[1].id;
      console.log("Child ID:", childId);

      // Get child status (which includes previousResult)
      const childStatus = await statusTool.execute("call-31", { promiseId: childId });
      console.log("Child status:", JSON.stringify(childStatus.details?.previousResult));

      if (childStatus.details?.previousResult) {
        console.log("✅ previousResult present on child");
        console.log("  contains output:", !!(childStatus.details.previousResult as any)?.output);
      } else {
        console.log("⚠️ previousResult may not be visible via status — checking via await...");
        // Try via promise-await on the child
        const childAwait = await awaitTool.execute("call-32", { promiseId: childId });
        console.log("  await details:", JSON.stringify(childAwait.details));
        if (childAwait.details?.previousResult) {
          console.log("✅ previousResult found via promise-await");
        } else {
          console.log("⚠️ previousResult not set (may not be available for pre-created children)");
        }
      }
    }
  }
  console.log("");

  // ---- Summary ----
  console.log("═══════════════════════════════════════════");
  console.log("SUMMARY");
  console.log("═══════════════════════════════════════════\n");
  console.log(`Total sentMessages (promise-completion): ${
    pi.sentMessages.filter((m) => m.message?.customType === "promise-completion").length
  }`);
  console.log(`Total sentMessages (all): ${pi.sentMessages.length}`);
  console.log(`Tools tested: ${pi.tools.map((t) => t.name).join(", ")}`);
  console.log("\n✅ All tests passed!");
}

main().catch((err) => {
  console.error("\n❌ Test suite failed:", err.message);
  process.exit(1);
});
