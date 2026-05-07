/**
 * Background Promise System
 *
 * Generic async background task system for pi agent.
 * 
 * Tools:
 * - promise-create: Start async task in background, returns immediately
 * - promise-await: Wait with smart heuristics when actually needed
 * - promise-status: Check without blocking
 * - promises-list: List all tracked promises
 * - promise-cancel: Cancel a pending/running promise
 * 
 * Features:
 * - Downloads with smart stall detection
 * - Commands return output for agent use
 * - Chained promises (run command after another completes)
 * - Results flow through to agent context
 */

import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";

import { Type } from "@mariozechner/pi-ai";
import { defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";

// =============================================================================
// Types
// =============================================================================

interface BackgroundPromise {
  id: string;
  name: string;
  type: "download" | "command";
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  targetPath?: string;
  url?: string;
  command?: string;
  thenCommand?: string;
  thenName?: string;
  lastKnownSize: number;
  result?: unknown;
  previousResult?: unknown;
  error?: string;
  createdAt: number;
  completedAt?: number;
  /** Track child PID so we can kill on cancel */
  childPid?: number;
}

interface AwaitOptions {
  promiseId: string;
  stallTimeout?: number;
  doneGracePeriod?: number;
}

// =============================================================================
// Promise Manager (Singleton)
// =============================================================================

const promises = new Map<string, BackgroundPromise>();
let promiseCounter = 0;

function generatePromiseId(): string {
  return `promise-${Date.now()}-${++promiseCounter}`;
}

function getPromise(id: string): BackgroundPromise | undefined {
  return promises.get(id);
}

function setPromise(promise: BackgroundPromise): void {
  promises.set(promise.id, promise);
}

// =============================================================================
// Completion Notification (set by registerTools to deliver results to agent)
// =============================================================================

let _notifyCompletion: ((promise: BackgroundPromise) => void) | undefined;

function notifyCompletion(promise: BackgroundPromise): void {
  try {
    _notifyCompletion?.(promise);
  } catch {
    // Agent session may no longer be active
  }
}

// =============================================================================
// Status Bar — show promise info in footer, expandable below-editor widget
// =============================================================================

let _statusBarCtx: { ui: any; theme: any } | undefined;
let _expanded = false;

function _getCompactStatus(theme: any): string | undefined {
  const all = Array.from(promises.values());
  if (all.length === 0) return undefined;

  const running = all.filter(p => p.status === "running").length;
  const pending = all.filter(p => p.status === "pending").length;
  const completed = all.filter(p => p.status === "completed").length;
  const failed = all.filter(p => p.status === "failed").length;

  const parts: string[] = [];
  if (running > 0) parts.push(theme.fg("accent", `\u25CF${running}`));
  if (pending > 0) parts.push(theme.fg("muted", `\u25CB${pending}`));
  if (completed > 0) parts.push(theme.fg("success", `\u2713${completed}`));
  if (failed > 0) parts.push(theme.fg("error", `\u2717${failed}`));

  const runningPromise = all.find(p => p.status === "running");
  if (runningPromise) {
    parts.push(theme.fg("dim", runningPromise.name));
  }

  return parts.join(" ");
}

function _getExpandedLines(theme: any): string[] {
  const all = Array.from(promises.values());
  if (all.length === 0) {
    return [theme.fg("dim", "\u2500 Background Promises \u2500 No active promises")];
  }

  const statusChars: Record<string, string> = {
    running: "\u25CF",
    pending: "\u25CB",
    completed: "\u2713",
    failed: "\u2717",
    cancelled: "\u2298",
  };
  const statusColors: Record<string, string> = {
    running: "accent",
    pending: "muted",
    completed: "success",
    failed: "error",
    cancelled: "dim",
  };

  const lines: string[] = [];
  lines.push(theme.fg("accent", theme.bold(" \u26A1 Background Promises")));
  lines.push("");

  for (const p of all) {
    const icon = statusChars[p.status] || "?";
    const color = statusColors[p.status] || "muted";
    const typeIcon = p.type === "download" ? "\u2193" : "$";

    let line = ` ${theme.fg(color, icon)} ${theme.fg("dim", typeIcon)} ${theme.fg("text", p.name)}`;

    if (p.status === "running") {
      const info = (p.command || p.url || "").slice(0, 60);
      if (info) line += ` ${theme.fg("muted", info)}`;
    } else if (p.status === "completed" && p.result) {
      const r = JSON.stringify(p.result);
      line += ` ${theme.fg("success", r.length > 50 ? r.slice(0, 47) + "..." : r)}`;
    } else if (p.status === "failed" && p.error) {
      const err = p.error.length > 60 ? p.error.slice(0, 57) + "..." : p.error;
      line += ` ${theme.fg("error", err)}`;
    }

    lines.push(line);
  }

  lines.push("");
  lines.push(theme.fg("dim", "Press ctrl+shift+b to collapse"));

  return lines;
}

function _updateStatusBar(ctx?: { ui: any; theme: any }): void {
  if (ctx) _statusBarCtx = ctx;
  if (!_statusBarCtx) return;

  const { ui, theme } = _statusBarCtx;

  // Compact: show in footer status
  try {
    ui.setStatus("bg-promises", _getCompactStatus(theme));
  } catch {
    // UI may not be fully initialized
  }

  // Expanded: show widget below editor
  if (_expanded) {
    try {
      ui.setWidget("bg-promises", _getExpandedLines(theme), {
        placement: "belowEditor",
      });
    } catch {
      // UI may not be fully initialized
    }
  } else {
    try {
      ui.setWidget("bg-promises", undefined);
    } catch {
      // UI may not be fully initialized
    }
  }
}

// =============================================================================
// Smart Stall Detection for Downloads
// =============================================================================

async function getFileSize(path: string): Promise<number> {
  try {
    const stats = await stat(path);
    return stats.size;
  } catch {
    return 0;
  }
}

async function waitForDownload(
  promise: BackgroundPromise,
  options: AwaitOptions
): Promise<{ content: { type: "text"; text: string }[]; details: { success: boolean; result?: unknown; error?: string }; isError?: boolean }> {
  if (!promise.targetPath) {
    return {
      content: [{ type: "text", text: "No target path for download" }],
      details: { success: false, error: "No target path for download" },
      isError: true
    };
  }

  const stallTimeout = (options.stallTimeout ?? 60) * 1000;
  const doneGracePeriod = (options.doneGracePeriod ?? 5) * 1000;

  let lastSize = await getFileSize(promise.targetPath);
  let lastGrowthTime = Date.now();

  while (true) {
    const currentSize = await getFileSize(promise.targetPath);

    if (currentSize > lastSize) {
      lastSize = currentSize;
      lastGrowthTime = Date.now();
      promise.lastKnownSize = currentSize;
    } else if (currentSize > 0 && currentSize === lastSize) {
      const timeSinceLastGrowth = Date.now() - lastGrowthTime;

      if (timeSinceLastGrowth >= doneGracePeriod) {
        return {
          content: [{ type: "text", text: `Download complete: ${promise.targetPath} (${currentSize} bytes)` }],
          details: { success: true, result: { path: promise.targetPath, size: currentSize } }
        };
      }
      if (timeSinceLastGrowth >= stallTimeout) {
        return {
          content: [{ type: "text", text: `Download stalled: no progress for ${options.stallTimeout}s` }],
          details: { success: false, error: `Stalled: no progress for ${options.stallTimeout}s` },
          isError: true
        };
      }
    }

    const current = getPromise(promise.id);
    if (!current || current.status === "cancelled") {
      return {
        content: [{ type: "text", text: "Promise was cancelled" }],
        details: { success: false, error: "Cancelled" },
        isError: true
      };
    }

    if (current.status === "completed") {
      return {
        content: [{ type: "text", text: `Download complete: ${promise.targetPath}` }],
        details: { success: true, result: { path: promise.targetPath } }
      };
    }

    if (current.status === "failed") {
      return {
        content: [{ type: "text", text: current.error ?? "Download failed" }],
        details: { success: false, error: current.error },
        isError: true
      };
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

// =============================================================================
// Download Runner
// =============================================================================

async function runDownload(promise: BackgroundPromise): Promise<void> {
  if (!promise.url || !promise.targetPath) {
    promise.status = "failed";
    promise.error = "Missing url or path";
    promise.completedAt = Date.now();
    setPromise(promise);
    await runChainedPromise(promise);
    return;
  }

  try {
    promise.status = "running";
    setPromise(promise);

    const proc = spawn("curl", ["-L", "-o", promise.targetPath, promise.url], {
      stdio: "ignore",
      detached: true,
    });
    promise.childPid = proc.pid;
    setPromise(promise);

    await new Promise<void>((resolve) => {
      proc.on("close", (code: number | null) => {
        if (code === 0) {
          promise.status = "completed";
          promise.result = { path: promise.targetPath };
        } else {
          promise.status = "failed";
          promise.error = `curl exited with code ${code}`;
        }
        promise.completedAt = Date.now();
        setPromise(promise);
        resolve();
      });
      proc.on("error", (err: Error) => {
        promise.status = "failed";
        promise.error = err.message;
        promise.completedAt = Date.now();
        setPromise(promise);
        resolve();
      });
    });
  } catch (err) {
    promise.status = "failed";
    promise.error = err instanceof Error ? err.message : String(err);
    promise.completedAt = Date.now();
    setPromise(promise);
  }

  await runChainedPromise(promise);
}

// =============================================================================
// Command Runner
// =============================================================================

async function runCommand(promise: BackgroundPromise): Promise<void> {
  if (!promise.command) {
    promise.status = "failed";
    promise.error = "Missing command";
    promise.completedAt = Date.now();
    setPromise(promise);
    await runChainedPromise(promise);
    return;
  }

  try {
    promise.status = "running";
    setPromise(promise);

    const proc = spawn("sh", ["-c", promise.command]);
    promise.childPid = proc.pid;
    setPromise(promise);

    let output = "";

    proc.stdout?.on("data", (data: Buffer) => {
      output += data.toString();
    });

    proc.stderr?.on("data", (data: Buffer) => {
      output += data.toString();
    });

    await new Promise<void>((resolve) => {
      proc.on("close", (code: number | null) => {
        if (code === 0) {
          promise.status = "completed";
          promise.result = { output: output.trim() };
        } else {
          promise.status = "failed";
          promise.error = `Command exited with code ${code}`;
          promise.result = { output: output.trim() };
        }
        promise.completedAt = Date.now();
        setPromise(promise);
        resolve();
      });
      
      proc.on("error", (err: Error) => {
        promise.status = "failed";
        promise.error = err.message;
        promise.completedAt = Date.now();
        setPromise(promise);
        resolve();
      });
    });
  } catch (err) {
    promise.status = "failed";
    promise.error = err instanceof Error ? err.message : String(err);
    promise.completedAt = Date.now();
    setPromise(promise);
  }

  await runChainedPromise(promise);
}

// =============================================================================
// Chained Promise Runner
// =============================================================================

async function runChainedPromise(promise: BackgroundPromise): Promise<void> {
  // Notify agent about completion before running chained command
  notifyCompletion(promise);
  if (!promise.thenCommand) return;
  
  // Wait a tick for the original promise to be fully settled
  await new Promise(r => setTimeout(r, 100));
  
  const chained: BackgroundPromise = {
    id: generatePromiseId(),
    name: promise.thenName ?? `chained from ${promise.name}`,
    type: "command",
    status: "pending",
    command: promise.thenCommand,
    previousResult: promise.result,
    lastKnownSize: 0,
    createdAt: Date.now(),
  };
  
  setPromise(chained);
  runCommand(chained);
}

// =============================================================================
// Tools Definition
// =============================================================================

function registerTools(pi: ExtensionAPI): void {

  // ---- Auto-notification when promises complete ----
  // When a background promise finishes, inject a message into the agent's
  // conversation so the agent is automatically notified without polling.
  _notifyCompletion = (promise: BackgroundPromise) => {
    try {
      if (promise.status === "completed") {
        const lines = [
          `\u{1F514} Promise "${promise.name}" completed!`,
          `\u2022 Type: ${promise.type}`,
          `\u2022 Status: completed`,
        ];
        if (promise.result) {
          const resultStr =
            typeof promise.result === "object"
              ? JSON.stringify(promise.result, null, 2)
              : String(promise.result);
          lines.push(`\u2022 Result: ${resultStr}`);
        }
        if (promise.previousResult) {
          lines.push(`\u2022 Previous result included for chained promises`);
        }
        lines.push(
          `You can use promise-await("${promise.id}") to get full structured details.`
        );

        pi.sendMessage(
          {
            customType: "promise-completion",
            content: lines.join("\n"),
            display: true,
          },
          { triggerTurn: true, deliverAs: "followUp" }
        );
      } else if (promise.status === "failed") {
        const lines = [
          `\u274C Promise "${promise.name}" failed!`,
          `\u2022 Type: ${promise.type}`,
          `\u2022 Error: ${promise.error ?? "Unknown error"}`,
        ];
        if (promise.result) {
          lines.push(`\u2022 Partial result: ${JSON.stringify(promise.result)}`);
        }
        lines.push(`You may want to retry or investigate.`);

        pi.sendMessage(
          {
            customType: "promise-completion",
            content: lines.join("\n"),
            display: true,
          },
          { triggerTurn: true, deliverAs: "followUp" }
        );
      }

      // Also update status bar
      _updateStatusBar();
    } catch {
      // Session may no longer be active, ignore silently
    }
  };

  // ---- Status Bar: show promise info in footer, expandable widget -----
  let sessionCtx: { ui: any; theme: any } | undefined;

  pi.on("session_start", async (_event, ctx) => {
    sessionCtx = { ui: ctx.ui, theme: ctx.ui.theme };
    _updateStatusBar(sessionCtx);
  });

  pi.registerShortcut("ctrl+shift+b", {
    description: "Toggle expanded promise status bar",
    handler: async (ctx) => {
      _expanded = !_expanded;
      _updateStatusBar({ ui: ctx.ui, theme: ctx.ui.theme });
      if (_expanded) {
        ctx.ui.notify("Promise status expanded \u2014 ctrl+shift+b to collapse", "info");
      }
    },
  });

  // ---------------------------------------------------------------------
  // promise-create: Start async task in background
  // ---------------------------------------------------------------------
  pi.registerTool(
    defineTool({
      name: "promise-create",
      label: "Promise Create",
      description: "Start an async task in background. Returns immediately with a promise ID. You can continue working on other tasks while it runs. When the promise completes, you'll be automatically notified with the result. Use promise-await for explicit blocking. Supports chaining with 'then' parameter.",
      promptSnippet: "Start a background task (download or command) and continue working",
      promptGuidelines: [
        "Use promise-create to start long-running tasks in the background. You get a promiseId immediately and can continue other work without blocking.",
        "When a promise completes, a 🔔 notification message is automatically delivered. You do not need to poll or await unless you need the result immediately.",
        "Use the 'then' parameter to chain a command that runs automatically after the first completes.",
        "Use promise-await(promiseId) only when you explicitly need the result before continuing with other work.",
      ],
      parameters: Type.Object({
        download: Type.Optional(Type.String({ description: "URL to download" })),
        path: Type.Optional(Type.String({ description: "File path to save to" })),
        command: Type.Optional(Type.String({ description: "Shell command to execute in background" })),
        then: Type.Optional(Type.String({ description: "Command to run after this one completes (chain)" })),
        name: Type.Optional(Type.String({ description: "Optional name for this promise" })),
      }),
      async execute(_toolCallId: string, args: {
        download?: string;
        path?: string;
        command?: string;
        then?: string;
        name?: string;
      }) {
        const isDownload = !!args.download;
        const name = args.name ?? (isDownload ? "download" : "command");

        const promise: BackgroundPromise = {
          id: generatePromiseId(),
          name,
          type: isDownload ? "download" : "command",
          status: "pending",
          url: args.download,
          targetPath: args.path,
          command: args.command,
          thenCommand: args.then,
          thenName: args.then ? `then-${name}` : undefined,
          lastKnownSize: 0,
          createdAt: Date.now(),
        };

        setPromise(promise);

        if (isDownload) {
          runDownload(promise);
        } else {
          runCommand(promise);
        }

        // Update status bar for the new promise
        _updateStatusBar();

        const text = args.then 
          ? `Started ${promise.type}: ${promise.id} (will chain to: ${args.then})`
          : `Started ${promise.type}: ${promise.id}`;

        return {
          content: [{ type: "text", text }],
          details: { promiseId: promise.id, name: promise.name, type: promise.type, status: "started", willChain: !!args.then },
        };
      },
    })
  );

  // ---------------------------------------------------------------------
  // promise-await: Wait for promise with smart heuristics
  // ---------------------------------------------------------------------
  pi.registerTool(
    defineTool({
      name: "promise-await",
      label: "Promise Await",
      description: "Wait for a background promise to complete. Returns result for agent use. Uses smart heuristics for downloads (growth detection) or simple await for commands.",
      promptSnippet: "Block until a background promise completes (usually not needed — results auto-deliver)",
      promptGuidelines: [
        "You generally do NOT need to call promise-await after promise-create. Results are automatically delivered as messages when the promise completes.",
        "Only use promise-await when you need the result immediately before continuing, or to get full structured details from the details field.",
      ],
      parameters: Type.Object({
        promiseId: Type.String({ description: "ID returned by promise-create" }),
        stallTimeout: Type.Optional(Type.Number({ description: "Seconds of no progress before timeout (downloads only, default: 60)" })),
        doneGracePeriod: Type.Optional(Type.Number({ description: "Seconds of no growth before considered done (downloads only, default: 5)" })),
      }),
      async execute(_toolCallId: string, args: {
        promiseId: string;
        stallTimeout?: number;
        doneGracePeriod?: number;
      }) {
        const promise = getPromise(args.promiseId);

        if (!promise) {
          return {
            content: [{ type: "text", text: `Promise not found: ${args.promiseId}` }],
            details: { success: false, error: `Promise not found: ${args.promiseId}` },
            isError: true
          };
        }

        if (promise.status === "completed") {
          // Include result in details for agent use
          return { 
            content: [{ type: "text", text: `Promise completed` }], 
            details: { 
              success: true, 
              result: promise.result,
              previousResult: promise.previousResult,
              error: "" 
            } 
          };
        }
        if (promise.status === "failed") {
          return { 
            content: [{ type: "text", text: promise.error ?? "Promise failed" }], 
            details: { 
              success: false, 
              error: promise.error ?? "Failed",
              result: promise.result 
            },
            isError: true 
          };
        }
        if (promise.status === "cancelled") {
          return { 
            content: [{ type: "text", text: "Promise was cancelled" }], 
            details: { success: false, error: "Cancelled" },
            isError: true 
          };
        }

        if (promise.type === "download") {
          return await waitForDownload(promise, args);
        }

        // For commands, simple poll with result passthrough
        while (getPromise(args.promiseId)?.status === "running") {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        
        const finalPromise = getPromise(args.promiseId);
        if (!finalPromise) {
          return { 
            content: [{ type: "text", text: "Promise disappeared" }], 
            details: { success: false, error: "Promise disappeared" },
            isError: true 
          };
        }
        
        if (finalPromise.status === "completed") {
          return { 
            content: [{ type: "text", text: "Completed" }], 
            details: { 
              success: true, 
              result: finalPromise.result,
              previousResult: finalPromise.previousResult,
              error: "" 
            } 
          };
        }
        
        return { 
          content: [{ type: "text", text: finalPromise.error ?? "Unknown state" }], 
          details: { success: false, error: finalPromise.error ?? "Unknown" },
          isError: true 
        };
      },
    })
  );

  // ---------------------------------------------------------------------
  // promise-status: Check without blocking
  // ---------------------------------------------------------------------
  pi.registerTool(
    defineTool({
      name: "promise-status",
      label: "Promise Status",
      description: "Check promise status without blocking. Returns immediately with last known result if available.",
      parameters: Type.Object({
        promiseId: Type.String({ description: "ID returned by promise-create" }),
      }),
      async execute(_toolCallId: string, args: { promiseId: string }) {
        const promise = getPromise(args.promiseId);

        if (!promise) {
          return { 
            content: [{ type: "text", text: `Promise not found: ${args.promiseId}` }], 
            details: { found: false, error: "Not found", promiseId: "", name: "", type: undefined as any, status: undefined as any, lastKnownSize: 0, createdAt: 0, completedAt: undefined } as any,
            isError: true 
          };
        }
        
        const text = `${promise.name} (${promise.type}): ${promise.status}${promise.lastKnownSize ? ` - ${promise.lastKnownSize} bytes` : ""}`;
        
        return {
          content: [{ type: "text", text }],
          details: {
            found: true,
            promiseId: promise.id,
            name: promise.name,
            type: promise.type,
            status: promise.status,
            lastKnownSize: promise.lastKnownSize,
            result: promise.result,
            previousResult: promise.previousResult,
            createdAt: promise.createdAt,
            completedAt: promise.completedAt,
            error: promise.error ?? "",
          } as any,
        };
      },
    })
  );

  // ---------------------------------------------------------------------
  // promises-list: List all tracked promises
  // ---------------------------------------------------------------------
  pi.registerTool(
    defineTool({
      name: "promises-list",
      label: "Promises List",
      description: "List all tracked background promises.",
      parameters: Type.Object({}),
      async execute() {
        const all: BackgroundPromise[] = [];
        for (const [, p] of promises) {
          all.push(p);
        }

        if (all.length === 0) {
          return {
            content: [{ type: "text", text: "No active promises" }],
            details: { count: 0, promises: [] }
          };
        }

        const lines = all.map((p) => `${p.id}: ${p.name} (${p.type}) - ${p.status}`);

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: {
            count: all.length,
            promises: all.map((p) => ({
              promiseId: p.id,
              name: p.name,
              type: p.type,
              status: p.status,
              hasResult: !!p.result,
              createdAt: p.createdAt,
            }))
          },
        };
      },
    })
  );

  // ---------------------------------------------------------------------
  // promise-cancel: Cancel a promise
  // ---------------------------------------------------------------------
  pi.registerTool(
    defineTool({
      name: "promise-cancel",
      label: "Promise Cancel",
      description: "Cancel a pending or running promise.",
      parameters: Type.Object({
        promiseId: Type.String({ description: "ID returned by promise-create" }),
      }),
      async execute(_toolCallId: string, args: { promiseId: string }) {
        const promise = getPromise(args.promiseId);

        if (!promise) {
          return {
            content: [{ type: "text", text: `Promise not found: ${args.promiseId}` }],
            details: { success: false, error: `Promise not found: ${args.promiseId}` },
            isError: true
          };
        }

        if (promise.status === "completed" || promise.status === "failed") {
          return { 
            content: [{ type: "text", text: `Promise already ${promise.status}` }], 
            details: { success: false, error: `Already ${promise.status}` },
            isError: true 
          };
        }
        
        promise.status = "cancelled";
        promise.error = "Cancelled by user";
        promise.completedAt = Date.now();
        // Update status bar after cancellation
        _updateStatusBar();
        // Kill child process if still running
        if (promise.childPid) {
          try {
            process.kill(promise.childPid, "SIGTERM");
          } catch {
            // Process may have already exited
          }
        }
        setPromise(promise);
        
        return { 
          content: [{ type: "text", text: `Cancelled: ${promise.id}` }], 
          details: { success: true, error: "" }
        };
      },
    })
  );
}

// =============================================================================
// Extension Entry Point
// =============================================================================

export default function (pi: ExtensionAPI) {
  registerTools(pi);
}