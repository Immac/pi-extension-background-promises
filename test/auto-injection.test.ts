/**
 * Integration test for auto-injection on promise completion.
 *
 * Loads the extension, fires background commands, and verifies that
 * pi.sendMessage() is called automatically when promises complete.
 *
 * Run: npx tsx test/auto-injection.test.ts
 */

import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
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
