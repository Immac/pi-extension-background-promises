/**
 * Background Promise System
 *
 * Default to using promises. Whenever you can work on something else while a
 * task runs, fire a promise and keep going. Results auto-deliver — no polling,
 * no blocking, no context-switching cost.
 * 
 * Core workflow:
 *   1. promise-create(command/download) → returns promiseId immediately
 *   2. Chain follow-ups with promise-then(promiseId, command, condition?)
 *   3. Keep working — results arrive automatically when ready
 *
 * Tools:
 * - promise-create: Start async task in background, returns immediately
 * - promise-then: Chain a task after an existing promise completes
 * - promise-block-until-complete: Wait with smart heuristics (avoid — chains are better)
 * - promise-status: Check without blocking
 * - promises-list: List all tracked promises
 * - promise-cancel: Cancel a pending/running promise
 * 
 * Features:
 * - Downloads with smart stall detection
 * - Commands return output for agent use
 * - Post-hoc chaining (promise-then at any point, not just at creation)
 * - Conditional chains (always, on-success, on-failure)
 * - Linked-list chain tracking with status bar visualization
 * - Results flow through to agent context
 */

import { spawn, execSync } from "node:child_process";
import { createWriteStream, writeFileSync, unlinkSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import { Type } from "typebox";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

// =============================================================================
// Types
// =============================================================================

interface BackgroundPromise {
  id: string;
  name: string;
  /** Semantic description of what this promise is doing — used to detect redundant work */
  subject?: string;
  type: "download" | "command";
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  targetPath?: string;
  url?: string;
  command?: string;
  /** Chained task fields */
  thenCommand?: string;
  thenDownload?: string;
  thenPath?: string;
  thenName?: string;
  thenCondition?: ThenCondition;
  /** Subject propagated to the chained promise */
  thenSubject?: string;
  /** ID of the chained promise (linked-list chain) */
  thenPromiseId?: string;
  lastKnownSize: number;
  totalSize?: number;
  result?: unknown;
  previousResult?: unknown;
  error?: string;
  createdAt: number;
  completedAt?: number;
  /** Track child PID so we can kill on cancel */
  childPid?: number;
  /** Prevent duplicate notification */
  notified?: boolean;
  /** Progress 0-100 for tracked promises */
  progress?: number;
  /** Last line of stdout — shown as status message in footer */
  statusMessage?: string;
}

interface AwaitOptions {
  promiseId: string;
  stallTimeout?: number;
  doneGracePeriod?: number;
}

// =============================================================================
// Types
// =============================================================================

type ThenCondition = "always" | "on-success" | "on-failure";

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
  // Auto-cleanup tmux session and temp files on terminal states
  if (promise.status === "completed" || promise.status === "failed" || promise.status === "cancelled") {
    _killTmuxSession(promise.id);
    _cleanupTempFiles(promise.id);
  }
  _saveState();
}

/**
 * Find a promise by its exact subject string.
 * Used by dedup and replace semantics.
 */
function findPromiseBySubject(subject: string): BackgroundPromise | undefined {
  for (const [, p] of promises) {
    if (p.subject === subject) return p;
  }
  return undefined;
}

// =============================================================================
// State Persistence — survive reloads
// =============================================================================

const _STATE_FILE = join(process.env.HOME || "/tmp", ".pi", "agent", "promise-state.json");

/** Serialize and save the promise map to disk. */
function _saveState(): void {
  try {
    const data = Array.from(promises.entries()).map(([, p]) => ({
      id: p.id,
      name: p.name,
      subject: p.subject,
      type: p.type,
      status: p.status,
      targetPath: p.targetPath,
      url: p.url,
      command: p.command,
      thenCommand: p.thenCommand,
      thenDownload: p.thenDownload,
      thenPath: p.thenPath,
      thenName: p.thenName,
      thenCondition: p.thenCondition,
      thenSubject: p.thenSubject,
      thenPromiseId: p.thenPromiseId,
      lastKnownSize: p.lastKnownSize,
      totalSize: p.totalSize,
      result: p.result,
      previousResult: p.previousResult,
      error: p.error,
      createdAt: p.createdAt,
      completedAt: p.completedAt,
      progress: p.progress,
      statusMessage: p.statusMessage,
      notified: p.notified,
    }));
    mkdirSync(dirname(_STATE_FILE), { recursive: true });
    writeFileSync(_STATE_FILE, JSON.stringify(data, null, 2), "utf-8");
  } catch {}
}

/** Load and restore the promise map from disk on startup, then re-establish tracking. */
function _loadState(): void {
  try {
    if (!existsSync(_STATE_FILE)) return;
    const data = JSON.parse(readFileSync(_STATE_FILE, "utf-8")) as any[];
    for (const item of data) {
      const p: BackgroundPromise = {
        id: item.id,
        name: item.name,
        subject: item.subject,
        type: item.type,
        status: item.status,
        targetPath: item.targetPath,
        url: item.url,
        command: item.command,
        thenCommand: item.thenCommand,
        thenDownload: item.thenDownload,
        thenPath: item.thenPath,
        thenName: item.thenName,
        thenCondition: item.thenCondition,
        thenSubject: item.thenSubject,
        thenPromiseId: item.thenPromiseId,
        lastKnownSize: item.lastKnownSize ?? 0,
        totalSize: item.totalSize,
        result: item.result,
        previousResult: item.previousResult,
        error: item.error,
        createdAt: item.createdAt,
        completedAt: item.completedAt,
        childPid: undefined, // cleared on reload — process is gone
        progress: item.progress,
        statusMessage: item.statusMessage,
        notified: item.notified,
      };
      promises.set(p.id, p);
      // Re-establish tmux polling for running promises
      if (p.status === "running" || p.status === "pending") {
        _resumePromiseTracking(p);
      }
    }
  } catch {}
}

/** After reload, re-discover a promise's tmux session and restart completion polling. */
function _resumePromiseTracking(promise: BackgroundPromise): void {
  try {
    // Find the tmux session by matching suffix against the promise ID
    const output = execSync(`tmux list-sessions -F "#S" 2>/dev/null`, { stdio: "pipe", encoding: "utf-8", timeout: 3000 });
    const lines = output.trim().split("\n");
    for (const line of lines) {
      if (line.endsWith(`-${promise.id}`)) {
        // Re-discovered: track it and restart polling for tmux-based promises
        _tmuxSessions.set(promise.id, line);
        _startTmuxPolling(promise);
        break;
      }
    }
  } catch {}
}

/** Clean up temp files for a completed promise. */
function _cleanupTempFiles(promiseId: string): void {
  try { unlinkSync(`/tmp/promise-${promiseId}.out`); } catch {}
  try { unlinkSync(`/tmp/promise-${promiseId}.sh`); } catch {}
}

// =============================================================================
// Chain Helpers
// =============================================================================

/**
 * Walk the linked list of thenPromiseId references to find the terminal
 * (last) promise in the chain.
 */
function findTerminalPromise(promise: BackgroundPromise): BackgroundPromise {
  let current = promise;
  while (current.thenPromiseId) {
    const next = promises.get(current.thenPromiseId);
    if (!next) break; // child disappeared, stop here
    current = next;
  }
  return current;
}

/**
 * Collect all root promises — those not referenced as a child via thenPromiseId.
 */
function collectRootPromises(): BackgroundPromise[] {
  const childIds = new Set<string>();
  for (const [, p] of promises) {
    if (p.thenPromiseId) childIds.add(p.thenPromiseId);
  }
  return Array.from(promises.values()).filter(p => !childIds.has(p.id));
}

// =============================================================================
// Chain Visualization Helpers
// =============================================================================

/**
 * Build a tree rendering for a single chain starting at root.
 * Shows indentation with arrows, status glyphs, conditions, and error reasons.
 * If terminalId is provided, marks that promise as "just added".
 */
function buildChainText(root: BackgroundPromise, terminalId?: string): string[] {
  const lines: string[] = [];
  let current: BackgroundPromise | undefined = root;
  let depth = 0;

  while (current) {
    const indentStr = "  ".repeat(depth);
    const arrow = depth === 0 ? "" : "└─ ";
    const glyph = _STATUS_GLYPH[current.status] || "?";

    let line = `${indentStr}${arrow}${glyph} ${current.id}: ${current.name} (${current.type})`;
    line += ` - ${current.status.toUpperCase()}`;

    // Show condition for chained promises
    if (depth > 0 && current.thenCondition) {
      line += ` [${current.thenCondition}]`;
    }

    // Show download progress
    if (current.type === "download" && current.status === "running" && current.totalSize && current.totalSize > 0) {
      const pct = Math.round((current.lastKnownSize / current.totalSize) * 100);
      const bar = _progressBar(pct);
      const dl = (current.lastKnownSize / 1024).toFixed(0);
      const tot = (current.totalSize / 1024).toFixed(0);
      line += ` ${bar} ${pct}% (${dl}KB/${tot}KB)`;
    }

    // Show cancellation reason
    if (current.status === "cancelled" && current.error) {
      const reason = current.error.length > 70 ? current.error.slice(0, 67) + "..." : current.error;
      line += ` — ${reason}`;
    }

    // Mark terminal if requested
    if (terminalId && current.id === terminalId) {
      line += " ← just added";
    }

    lines.push(line);

    // Walk to next in linked list
    if (current.thenPromiseId) {
      current = promises.get(current.thenPromiseId) ?? undefined;
    } else {
      current = undefined;
    }
    depth++;
  }

  return lines;
}

/**
 * Build a compact one-line chain path for a single root promise.
 * Example: "step1 (✓ completed) → step2 (● running) → step3 (○ pending)"
 */
function buildChainPathText(root: BackgroundPromise): string {
  const parts: string[] = [];
  let current: BackgroundPromise | undefined = root;

  while (current) {
    const glyph = _STATUS_GLYPH[current.status] || "?";
    const display = `${current.name} (${glyph} ${current.status})`;
    parts.push(display);
    current = current.thenPromiseId ? (promises.get(current.thenPromiseId) ?? undefined) : undefined;
  }

  return parts.join(" → ");
}

/**
 * Build the full forest rendering: all root chains with tree indentation.
 */
function buildAllChainsText(): string[] {
  const roots = collectRootPromises();
  if (roots.length === 0) return ["No active promises"];

  // Prioritise running/pending first
  const priority = roots.filter(r => r.status === "running" || r.status === "pending");
  const rest = roots.filter(r => r.status !== "running" && r.status !== "pending");
  const sorted = [...priority, ...rest];

  const lines: string[] = ["Root chains:"];
  for (const root of sorted) {
    lines.push("");
    lines.push(...buildChainText(root));
  }

  return lines;
}

// =============================================================================
// Completion Notification (set by registerTools to deliver results to agent)
// =============================================================================

let _notifyCompletion: ((promise: BackgroundPromise) => void) | undefined;

/**
 * Promises being explicitly blocked on via promise-block-until-complete.
 * notifyCompletion skips these — the result already went to the LLM directly.
 */
const _awaitedPromises = new Set<string>();

function notifyCompletion(promise: BackgroundPromise): void {
  if (promise.notified) return;
  // If the LLM explicitly awaited this promise, the result was already
  // returned directly from promise-block-until-complete. Suppress the notification to
  // avoid a duplicate follow-up turn.
  if (_awaitedPromises.has(promise.id)) return;
  promise.notified = true;
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
const _progressTimers = new Map<string, ReturnType<typeof setInterval>>();
/**
 * AbortControllers for in-flight fetch-based downloads.
 * Allows promise-cancel to abort an active HTTP stream.
 */
const _downloadControllers = new Map<string, AbortController>();

const _STATUS_GLYPH: Record<string, string> = {
  running: "\u25CF",
  pending: "\u25CB",
  completed: "\u2713",
  failed: "\u2717",
  cancelled: "\u2298",
};

const _STATUS_COLOR: Record<string, string> = {
  running: "accent",
  pending: "muted",
  completed: "success",
  failed: "error",
  cancelled: "dim",
};

/** Halves sweep around the circle — same size throughout.
 * Running and pending differentiated by color (accent vs muted). */
const _ANIM_FRAMES = ["\u25D3", "\u25D1", "\u25D2", "\u25D0"];

// =============================================================================
// Block Progress Bars
// =============================================================================

/** Block fill levels: empty, ▁(1/4), ▃(1/2), ▆(3/4), █(full) */
const _BLOCK_BAR = ["\u2800", "\u2581", "\u2583", "\u2586", "\u2588"];

/** Blink-off index for each block level (null = can't blink). */
const _BLOCK_BLINK: (number | null)[] = [null, 0, 1, 2, 3];

/** Aging shades: just-aged → medium-aged → oldest */
const _BLOCK_SHADES = ["\u2593", "\u2592", "\u2591"];

/** Extra fill characters for smooth animation: ▁▂▃▄▅▆▇█ */
const _FILL_CHARS = ["\u2581", "\u2582", "\u2583", "\u2584", "\u2585", "\u2586", "\u2587", "\u2588"];

let _animBlink = false;
let _animDisplayLevel = 0;
let _lastPartialLevel = 0;
const _ANIM_VELOCITY = 0.4;

/** Convert a progress percentage (0-100) to a 4-block progress bar string. */
function _progressToBlocks(pct: number, _blink: boolean): string {
  const totalSteps = 16;
  const step = Math.min(Math.max(Math.round(pct / 100 * totalSteps), 0), totalSteps);
  const fullBars = Math.floor(step / 4);
  const partialLevel = step % 4;

  // Smoothly follow the real partialLevel at a limited speed.
  // At boundaries (completed bar), snap to 0 immediately instead of ramping down.
  if (_lastPartialLevel > 0 && partialLevel === 0) {
    _animDisplayLevel = 0;
  }
  _lastPartialLevel = partialLevel;

  const diff = partialLevel - _animDisplayLevel;
  if (Math.abs(diff) > 0.005) {
    _animDisplayLevel += Math.sign(diff) * Math.min(Math.abs(diff), _ANIM_VELOCITY);
  } else {
    _animDisplayLevel = partialLevel;
  }
  const animLevel = Math.max(_animDisplayLevel, 0);

  const bars: string[] = [];
  for (let i = 0; i < 4; i++) {
    if (i < fullBars) {
      const age = (fullBars - 1 - i) - 1;
      bars.push(age < 0 ? _BLOCK_BAR[4] : _BLOCK_SHADES[Math.min(age, _BLOCK_SHADES.length - 1)]);
    } else if (i === fullBars) {
      if (animLevel > 0.01) {
        const smoothIdx = Math.min(
          Math.round((animLevel / 4) * (_FILL_CHARS.length - 1)),
          _FILL_CHARS.length - 1
        );
        bars.push(_FILL_CHARS[smoothIdx]);
      } else {
        bars.push("\u2800");
      }
    } else {
      bars.push("\u2800");
    }
  }
  return "[" + bars.join("") + "]";
}

/** Check if a promise has trackable progress. */
function _hasProgress(promise: BackgroundPromise): boolean {
  return !!(promise.progress !== undefined || (promise.type === "download" && promise.totalSize && promise.totalSize > 0));
}

let _animFrame = 0;
let _animTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Returns an animated glyph for running/pending promises, or the static
 * glyph for completed/failed/cancelled.
 */
function _statusGlyph(status: string): string {
  if (status === "running" || status === "pending") {
    return _ANIM_FRAMES[_animFrame % _ANIM_FRAMES.length];
  }
  return _STATUS_GLYPH[status] || "?";
}

function _progressBar(pct: number, width = 8): string {
  const filled = Math.round((pct / 100) * width);
  return "\u2588".repeat(filled) + "\u2592".repeat(width - filled);
}

/**
 * Build a compact chain representation for a single root promise.
 * Variant D: ①→$✓→$○  (root→typeStatus→typeStatus…)
 */
function _chainCompact(root: BackgroundPromise, rootIndex: number, theme: any): string {
  const parts: string[] = [];
  let current: BackgroundPromise | undefined = root;
  let isFirst = true;

  while (current) {
    const typeIcon = current.type === "download" ? "\u2193" : "$";
    const color = _STATUS_COLOR[current.status] || "muted";

    // Show braille progress bar for promises with trackable progress
    if (current.status === "running" && _hasProgress(current)) {
      const pct = current.progress ?? (current.totalSize
        ? Math.round((current.lastKnownSize / current.totalSize) * 100)
        : 0);
      const bar = _progressToBlocks(pct, _animBlink);
      const pctStr = ` ${Math.min(pct, 99)}%`;

      if (isFirst) {
        parts.push(theme.fg("text", `${rootIndex}\u2192`));
        parts.push(theme.fg(color, `${typeIcon}${bar}`));
        parts.push(theme.fg("accent", pctStr));
        if (current.statusMessage) {
          const msg = current.statusMessage.length > 20 ? current.statusMessage.slice(0, 17) + "..." : current.statusMessage;
          parts.push(theme.fg("dim", ` "${msg}"`));
        }
        isFirst = false;
      } else {
        parts.push(theme.fg("dim", "\u2192"));
        parts.push(theme.fg(color, `${typeIcon}${bar}`));
        parts.push(theme.fg("accent", pctStr));
        if (current.statusMessage) {
          const msg = current.statusMessage.length > 20 ? current.statusMessage.slice(0, 17) + "..." : current.statusMessage;
          parts.push(theme.fg("dim", ` "${msg}"`));
        }
      }

      current = current.thenPromiseId ? (promises.get(current.thenPromiseId) ?? undefined) : undefined;
      continue;
    }

    const glyph = _statusGlyph(current.status);

    // For running downloads with known total, show percentage suffix
    let pctSuffix = "";
    if (current.type === "download" && current.status === "running" && current.totalSize && current.totalSize > 0) {
      const pct = Math.round((current.lastKnownSize / current.totalSize) * 100);
      pctSuffix = ` ${Math.min(pct, 99)}%`;
    }

    if (isFirst) {
      parts.push(theme.fg("text", `${rootIndex}\u2192`));
      parts.push(theme.fg(color, `${typeIcon}${glyph}${pctSuffix}`));
      if (current.status === "running" && current.statusMessage) {
        const msg = current.statusMessage.length > 20 ? current.statusMessage.slice(0, 17) + "..." : current.statusMessage;
        parts.push(theme.fg("dim", ` "${msg}"`));
      }
      isFirst = false;
    } else {
      parts.push(theme.fg("dim", "\u2192"));
      parts.push(theme.fg(color, `${typeIcon}${glyph}${pctSuffix}`));
      if (current.status === "running" && current.statusMessage) {
        const msg = current.statusMessage.length > 20 ? current.statusMessage.slice(0, 17) + "..." : current.statusMessage;
        parts.push(theme.fg("dim", ` "${msg}"`));
      }
    }

    current = current.thenPromiseId ? (promises.get(current.thenPromiseId) ?? undefined) : undefined;
  }

  return parts.join("");
}

function _getCompactStatus(theme: any): string | undefined {
  const all = Array.from(promises.values());
  if (all.length === 0) return undefined;

  // Quick aggregate counts
  const running = all.filter(p => p.status === "running").length;
  const pending = all.filter(p => p.status === "pending").length;
  const completed = all.filter(p => p.status === "completed").length;
  const failed = all.filter(p => p.status === "failed").length;

  // Aggregate summary (always shown)
  const aggParts: string[] = [];
  if (running > 0) aggParts.push(theme.fg("accent", `${_statusGlyph("running")}${running}`));
  if (pending > 0) aggParts.push(theme.fg("muted", `${_statusGlyph("pending")}${pending}`));
  if (completed > 0) aggParts.push(theme.fg("success", `\u2713${completed}`));
  if (failed > 0) aggParts.push(theme.fg("error", `\u2717${failed}`));

  // Build chain view — limit to 3 roots, prioritise running/pending first
  const roots = collectRootPromises();
  const priority: BackgroundPromise[] = [];
  const rest: BackgroundPromise[] = [];
  for (const r of roots) {
    if (r.status === "running" || r.status === "pending") {
      priority.push(r);
    } else {
      rest.push(r);
    }
  }
  const sorted = [...priority, ...rest];
  const visible = sorted.slice(0, 9);
  const remaining = sorted.length - visible.length;

  let chainStr = "";
  if (visible.length > 0) {
    const chainParts = visible.map((r, i) => _chainCompact(r, i + 1, theme));
    chainStr = chainParts.join(" | ");
    if (remaining > 0) {
      chainStr += ` | ${theme.fg("dim", `+${remaining}`)}`;
    }
  }

  // Combine: F4 hint + chain view + aggregate counts
  const hint = theme.fg("dim", "[/promise]");
  const middle = chainStr ? `${chainStr}  ${aggParts.join(" ")}` : aggParts.join(" ");
  const result = `${hint} ${middle}`;
  return result;
}

function _expandedLine(
  promise: BackgroundPromise,
  theme: any,
  depth: number,
  isLast: boolean
): string {
  const color = _STATUS_COLOR[promise.status] || "muted";
  const typeIcon = promise.type === "download" ? "\u2193" : "$";

  const indent = depth === 0 ? " " : "  " + "\u2502  ".repeat(depth - 1) + (isLast ? "\u2514\u2500" : "\u251C\u2500");

  // Show braille progress bar for promises with trackable progress
  if (promise.status === "running" && _hasProgress(promise)) {
    const pct = promise.progress ?? (promise.totalSize
      ? Math.round((promise.lastKnownSize / promise.totalSize) * 100)
      : 0);
    const bar = _progressToBlocks(pct, _animBlink);
    const pctStr = `${Math.min(pct, 99)}%`;
    let line = `${indent}${theme.fg(color, bar)} ${theme.fg("dim", typeIcon)} ${theme.fg("text", promise.name)}`;
    if (promise.thenCondition && depth > 0) {
      line += ` ${theme.fg("dim", `(${promise.thenCondition})`)}`;
    }
    line += ` ${theme.fg("accent", pctStr)}`;
    if (promise.statusMessage) {
      const msg = promise.statusMessage.length > 30 ? promise.statusMessage.slice(0, 27) + "..." : promise.statusMessage;
      line += ` ${theme.fg("dim", `\u201C${msg}\u201D`)}`;
    }
    if (promise.type === "download" && promise.totalSize && promise.totalSize > 0) {
      const downloaded = (promise.lastKnownSize / 1024).toFixed(0);
      const total = (promise.totalSize / 1024).toFixed(0);
      line += ` ${theme.fg("muted", `(${downloaded}KB/${total}KB)`)}`;
    }
    return line;
  }

  const glyph = _statusGlyph(promise.status);

  let line = `${indent}${theme.fg(color, glyph)} ${theme.fg("dim", typeIcon)} ${theme.fg("text", promise.name)}`;

  if (promise.thenCondition && depth > 0) {
    line += ` ${theme.fg("dim", `(${promise.thenCondition})`)}`;
  }

  if (promise.status === "running") {
    if (promise.type === "download" && promise.totalSize && promise.totalSize > 0) {
      const pct = Math.round((promise.lastKnownSize / promise.totalSize) * 100);
      const bar = _progressBar(pct);
      const downloaded = (promise.lastKnownSize / 1024).toFixed(0);
      const total = (promise.totalSize / 1024).toFixed(0);
      line += ` ${theme.fg("accent", bar)} ${theme.fg("text", `${pct}%`)} ${theme.fg("muted", `(${downloaded}KB/${total}KB)`)}`;
    } else {
      const info = (promise.command || promise.url || "").slice(0, 50);
      if (info) line += ` ${theme.fg("muted", info)}`;
    }
    if (promise.status === "running" && promise.statusMessage) {
      const msg = promise.statusMessage.length > 30 ? promise.statusMessage.slice(0, 27) + "..." : promise.statusMessage;
      line += ` ${theme.fg("dim", `\u201C${msg}\u201D`)}`;
    }
  } else if (promise.status === "completed" && promise.result) {
    const r = JSON.stringify(promise.result);
    line += ` ${theme.fg("success", r.length > 40 ? r.slice(0, 37) + "..." : r)}`;
  } else if (promise.status === "failed" && promise.error) {
    const err = promise.error.length > 50 ? promise.error.slice(0, 47) + "..." : promise.error;
    line += ` ${theme.fg("error", err)}`;
  }

  return line;
}

function _walkExpandedChain(
  promise: BackgroundPromise,
  theme: any,
  depth: number,
  lines: string[]
): void {
  // With linked-list model, there's at most one child via thenPromiseId
  const child = promise.thenPromiseId ? promises.get(promise.thenPromiseId) ?? undefined : undefined;
  if (child) {
    lines.push(_expandedLine(child, theme, depth + 1, true));
    _walkExpandedChain(child, theme, depth + 1, lines);
  }
}

function _getExpandedLines(theme: any): string[] {
  const roots = collectRootPromises();
  if (roots.length === 0) {
    return [theme.fg("dim", "\u2500 Background Promises \u2500 No active promises")];
  }

  // Prioritise: running/pending first, then completed/failed
  const priority: BackgroundPromise[] = [];
  const rest: BackgroundPromise[] = [];
  for (const r of roots) {
    if (r.status === "running" || r.status === "pending") {
      priority.push(r);
    } else {
      rest.push(r);
    }
  }
  const sorted = [...priority, ...rest];

  // Show at most 10 roots
  const MAX_VISIBLE_ROOTS = 10;
  const visible = sorted.slice(0, MAX_VISIBLE_ROOTS);
  const remaining = sorted.length - visible.length;

  const lines: string[] = [];
  lines.push(theme.fg("accent", theme.bold(" \u26A1 Background Promises")));
  lines.push("");

  for (const root of visible) {
    lines.push(_expandedLine(root, theme, 0, false));
    _walkExpandedChain(root, theme, 0, lines);
  }

  if (remaining > 0) {
    lines.push(theme.fg("dim", `  \u22EF and ${remaining} more root promise${remaining === 1 ? "" : "s"}`));
  }

  lines.push("");
  lines.push(theme.fg("dim", "Use /promise to collapse"));

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

  // Manage animation timer — runs while any promise is running or pending
  if (_hasActivePromises()) {
    _startAnimTimer();
  } else {
    _stopAnimTimer();
    _animFrame = 0;
  }
}

// =============================================================================
// Animation Timer
// =============================================================================

function _hasActivePromises(): boolean {
  for (const [, p] of promises) {
    if (p.status === "running" || p.status === "pending") return true;
  }
  return false;
}

function _startAnimTimer(): void {
  if (_animTimer) return;
  _animTimer = setInterval(() => {
    if (!_hasActivePromises()) {
      _stopAnimTimer();
      return;
    }
    _animFrame++;
    _animBlink = !_animBlink;
    // Lightweight: only update compact footer, not the expanded widget
    if (!_statusBarCtx) return;
    const { ui, theme } = _statusBarCtx;
    try {
      ui.setStatus("bg-promises", _getCompactStatus(theme));
    } catch {
      // UI may not be fully initialized
    }
  }, 120);
}

function _stopAnimTimer(): void {
  if (_animTimer) {
    clearInterval(_animTimer);
    _animTimer = null;
  }
}

// =============================================================================
// Smart Stall Detection for Downloads
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

  while (true) {
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
        content: [{ type: "text", text: `Download complete: ${promise.targetPath} (${current.lastKnownSize} bytes)` }],
        details: { success: true, result: { path: promise.targetPath, size: current.lastKnownSize } }
      };
    }

    if (current.status === "failed") {
      return {
        content: [{ type: "text", text: current.error ?? "Download failed" }],
        details: { success: false, error: current.error },
        isError: true
      };
    }

    if (Date.now() - (current.createdAt ?? Date.now()) >= stallTimeout) {
      return {
        content: [{ type: "text", text: `Download stalled: no progress for ${options.stallTimeout}s` }],
        details: { success: false, error: `Stalled: no progress for ${options.stallTimeout}s` },
        isError: true
      };
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

// =============================================================================
// Content-Length Helper
// =============================================================================

/** Head request via fetch() — no external curl dependency. */
async function getContentLength(url: string): Promise<number | undefined> {
  try {
    const response = await fetch(url, { method: "HEAD" });
    if (!response.ok) return undefined;
    const length = response.headers.get("content-length");
    return length ? parseInt(length, 10) : undefined;
  } catch {
    return undefined;
  }
}

// =============================================================================
// Download Runner (fetch-based — no external curl dependency)
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

  // -- Head request for Content-Length (best-effort) --
  if (!promise.totalSize) {
    const contentLength = await getContentLength(promise.url);
    if (contentLength !== undefined) {
      promise.totalSize = contentLength;
    }
  }

  const abortController = new AbortController();
  _downloadControllers.set(promise.id, abortController);

  promise.status = "running";
  setPromise(promise);

  // Status-bar refresh interval (lighter — progress tracked via stream)
  const pollInterval = setInterval(() => _updateStatusBar(), 1000);
  _progressTimers.set(promise.id, pollInterval);

  try {
    const response = await fetch(promise.url, {
      signal: abortController.signal,
    });

    if (!response.ok) {
      promise.status = "failed";
      promise.error = `HTTP ${response.status}: ${response.statusText}`;
      promise.completedAt = Date.now();
      setPromise(promise);
      _downloadControllers.delete(promise.id);
      clearInterval(pollInterval);
      _progressTimers.delete(promise.id);
      _updateStatusBar();
      await runChainedPromise(promise);
      return;
    }

    // Update total size from response headers if not already set
    if (!promise.totalSize) {
      const length = response.headers.get("content-length");
      if (length) promise.totalSize = parseInt(length, 10);
    }

    const reader = response.body!.getReader();
    const fileStream = createWriteStream(promise.targetPath);

    let bytesDownloaded = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        fileStream.write(Buffer.from(value));
        bytesDownloaded += value.length;
        promise.lastKnownSize = bytesDownloaded;
        if (promise.totalSize && promise.totalSize > 0) {
          promise.progress = Math.round((bytesDownloaded / promise.totalSize) * 100);
        }
        setPromise(promise);

        // Check for external cancellation (promise-cancel or replace)
        // Re-read from map to get the latest status (may have been changed by promise-cancel)
        if (getPromise(promise.id)?.status === "cancelled") {
          abortController.abort();
          break;
        }
      }

      await new Promise<void>((resolve, reject) => {
        fileStream.end();
        fileStream.on("finish", () => {
          const latest = getPromise(promise.id);
          if (latest && latest.status !== "cancelled") {
            promise.status = "completed";
            promise.result = { path: promise.targetPath };
          }
          promise.completedAt = Date.now();
          setPromise(promise);
          resolve();
        });
        fileStream.on("error", (err: Error) => {
          const latest = getPromise(promise.id);
          if (latest && latest.status !== "cancelled") {
            promise.status = "failed";
            promise.error = err.message;
          }
          promise.completedAt = Date.now();
          setPromise(promise);
          resolve();
        });
      });
    } catch (streamErr) {
      // AbortError from cancellation is expected — don't overwrite status
      if (streamErr instanceof DOMException && streamErr.name === "AbortError") {
        // Status already set to "cancelled" by promise-cancel or the loop above
      } else {
        const latest = getPromise(promise.id);
        if (!latest || latest.status !== "cancelled") {
          promise.status = "failed";
          promise.error = streamErr instanceof Error ? streamErr.message : String(streamErr);
          promise.completedAt = Date.now();
          setPromise(promise);
        }
      }
    } finally {
      fileStream.destroy();
      _downloadControllers.delete(promise.id);
      clearInterval(pollInterval);
      _progressTimers.delete(promise.id);
      _updateStatusBar();
    }
  } catch (fetchErr) {
    // AbortError from cancellation is expected — don't overwrite status
    if (fetchErr instanceof DOMException && fetchErr.name === "AbortError") {
      // Status already set by promise-cancel or the inner loop
    } else {
      const latest = getPromise(promise.id);
      if (!latest || latest.status !== "cancelled") {
        promise.status = "failed";
        promise.error = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
        promise.completedAt = Date.now();
        setPromise(promise);
      }
    }
    _downloadControllers.delete(promise.id);
    clearInterval(pollInterval);
    _progressTimers.delete(promise.id);
    _updateStatusBar();
  }

  await runChainedPromise(promise);
}

// =============================================================================
// Command Runner
// =============================================================================

/**
 * Run a command promise. Dispatches to tmux if available, otherwise uses
 * direct spawn-based execution.
 */
function runCommand(promise: BackgroundPromise): void {
  if (_isTmuxAvailable()) {
    _runInTmux(promise);
  } else {
    _runDirect(promise);
  }
}


// =============================================================================
// Chained Promise Runner
// =============================================================================

async function runChainedPromise(promise: BackgroundPromise): Promise<void> {
  // Notify agent — structurally safe because pre-created children already
  // exist in the linked list, so promise-then always calls findTerminalPromise
  // on the right node and writes to the terminal's thenCommand, not this one.
  notifyCompletion(promise);

  const hasThen = !!(promise.thenCommand || promise.thenDownload);
  if (!hasThen) return;

  // ---- Cancelled parent: cascade to pre-created child ----
  if (promise.status === "cancelled") {
    const child = promise.thenPromiseId ? getPromise(promise.thenPromiseId) : undefined;
    if (child && (child.status === "pending" || child.status === "running")) {
      child.status = "cancelled";
      child.error = `Parent ${promise.id} was cancelled — chain aborted`;
      child.completedAt = Date.now();
      setPromise(child);
      notifyCompletion(child);
    }
    _updateStatusBar();
    return;
  }

  // ---- Condition check ----
  if (promise.thenCondition && promise.thenCondition !== "always") {
    const parentSuccess = promise.status === "completed";
    const shouldSkip =
      (promise.thenCondition === "on-success" && !parentSuccess) ||
      (promise.thenCondition === "on-failure" && parentSuccess);

    if (shouldSkip) {
      const child = promise.thenPromiseId ? getPromise(promise.thenPromiseId) : undefined;
      if (child) {
        child.status = "cancelled";
        child.error = `Skipped: parent ${promise.id} status ${promise.status} did not meet condition ${promise.thenCondition}`;
        child.completedAt = Date.now();
        setPromise(child);
        notifyCompletion(child);
      } else {
        // No pre-created child — create a cancelled placeholder for audit trail
        const skipped: BackgroundPromise = {
          id: generatePromiseId(),
          name: promise.thenName ?? `skipped-${promise.name}`,
          type: promise.thenDownload ? "download" : "command",
          status: "cancelled",
          command: promise.thenCommand,
          url: promise.thenDownload,
          targetPath: promise.thenPath,
          error: `Skipped: parent ${promise.id} status ${promise.status} did not meet condition ${promise.thenCondition}`,
          lastKnownSize: 0,
          createdAt: Date.now(),
        };
        setPromise(skipped);
        notifyCompletion(skipped);
      }
      _updateStatusBar();
      return;
    }
  }

  // ---- Use pre-created child or create from thenCommand/thenDownload ----
  let chained = promise.thenPromiseId ? getPromise(promise.thenPromiseId) : undefined;

  if (!chained) {
    // No pre-created child (e.g. promise-then after the fact without then at create)
    const isDownload = !!promise.thenDownload;
    chained = {
      id: generatePromiseId(),
      name: promise.thenName ?? `chained from ${promise.name}`,
      subject: promise.thenSubject,
      type: isDownload ? "download" : "command",
      status: "pending",
      command: promise.thenCommand,
      url: promise.thenDownload,
      targetPath: promise.thenPath,
      previousResult: promise.result,
      lastKnownSize: 0,
      createdAt: Date.now(),
    };
    promise.thenPromiseId = chained.id;
    setPromise(promise);
  } else {
    // Pre-created child found — set previousResult now
    chained.previousResult = promise.result;
  }

  // If child was already cancelled (e.g. by cancel-cascade or direct cancel),
  // don't start it — just update state and return.
  if (chained.status === "cancelled") {
    setPromise(chained);
    _updateStatusBar();
    return;
  }

  setPromise(chained);
  _updateStatusBar();

  if (chained.type === "download") {
    runDownload(chained);
  } else {
    runCommand(chained);
  }
}

// =============================================================================
// Tmux Integration
// =============================================================================

/** Cached tmux availability check */
let _tmuxChecked = false;
let _tmuxAvailable = false;

/** Track tmux session names by promise ID for cleanup */
/** Unique instance ID per pi session — used to namespace tmux sessions
 * so cleanup only kills orphans from this pi instance, not other sessions. */
const _instanceId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

const _tmuxSessions = new Map<string, string>();

/** Current tmux session name (if running inside tmux), sanitized for use in session names. */
let _currentTmuxSession: string | null = null;

function _getCurrentTmuxSession(): string | undefined {
  if (_currentTmuxSession !== null) return _currentTmuxSession || undefined;
  if (!process.env.TMUX) {
    _currentTmuxSession = "";
    return undefined;
  }
  try {
    const raw = execSync("tmux display-message -p '#{session_name}' 2>/dev/null", { stdio: "pipe", encoding: "utf-8", timeout: 2000 }).trim();
    // Sanitize to alphanumeric + hyphens only for safe use in shell commands
    _currentTmuxSession = raw.replace(/[^a-zA-Z0-9\-]/g, "-") || "";
  } catch {
    _currentTmuxSession = "";
  }
  return _currentTmuxSession || undefined;
}

/**
 * Check if we're inside a tmux session and tmux binary is available.
 */
function _isTmuxAvailable(): boolean {
  if (_tmuxChecked) return _tmuxAvailable;
  _tmuxChecked = true;
  try {
    execSync("tmux -V", { stdio: "ignore" });
    _tmuxAvailable = true;
  } catch {
    _tmuxAvailable = false;
  }
  return _tmuxAvailable;
}

/**
 * Sanitize a string for use as a tmux session name — alphanumeric + hyphens only.
 */
function _toTmuxName(promise: BackgroundPromise): string {
  const parentSession = _getCurrentTmuxSession();
  const prefix = parentSession
    ? `promise-${parentSession}-${_instanceId}-`
    : `promise-${_instanceId}-`;
  const maxTotal = 64;
  const sanitized = promise.id.replace(/[^a-zA-Z0-9\-]/g, "-");
  const available = maxTotal - prefix.length;
  return prefix + sanitized.slice(0, Math.max(available, 0));
}

/** Kill a tmux session by promise ID. Called on cancel/shutdown. */
/** Kill all orphaned promise tmux sessions — sessions from previous pi loads
 * that were never cleaned up. Called on startup and shutdown. */
function _killOrphanedTmuxSessions(): void {
  try {
    const parentSession = _getCurrentTmuxSession();
    // Scope cleanup to this tmux session only — other sessions' promises untouched
    const orphanPrefix = parentSession
      ? `promise-${parentSession}-`
      : `promise-`;
    const output = execSync(`tmux list-sessions -F "#S" 2>/dev/null`, { stdio: "pipe", encoding: "utf-8", timeout: 3000 });
    const lines = output.trim().split("\n");
    for (const line of lines) {
      if (line.startsWith(orphanPrefix)) {
        try {
          execSync(`tmux kill-session -t "${line}" 2>/dev/null`, { stdio: "ignore" });
        } catch {}
      }
    }
  } catch {
    // tmux may not be available
  }
}

/** Mark a promise as completed/failed/cancelled and clean up resources. */
function _finalizePromise(promise: BackgroundPromise): void {
  _killTmuxSession(promise.id);
  _cleanupTempFiles(promise.id);
  setPromise(promise);
}

function _killTmuxSession(promiseId: string): void {
  const sessionName = _tmuxSessions.get(promiseId);
  if (!sessionName) return;
  try {
    execSync(`tmux kill-session -t "${sessionName}" 2>/dev/null`, { stdio: "ignore" });
  } catch {
    // Session may already be dead
  }
  _tmuxSessions.delete(promiseId);
  // Clean up temp files
  const outFile = `/tmp/promise-${promiseId}.out`;
  const scriptFile = `/tmp/promise-${promiseId}.sh`;
  try { unlinkSync(outFile); } catch {}
  try { unlinkSync(scriptFile); } catch {}
}

/**
 * Read captured output from the tmp file. Returns trimmed string or empty.
 * Marker format: ---PROMISE-DONE:<exit_code>---
 */
function _readTmuxOutput(promiseId: string): string {
  const outFile = `/tmp/promise-${promiseId}.out`;
  try {
    if (!existsSync(outFile)) return "";
    let content = readFileSync(outFile, "utf-8");
    // Strip the completion marker if present (trailing \n from echo is OK)
    const markerMatch = content.match(/\n---PROMISE-DONE:\d+---(\n?)$/);
    if (markerMatch) content = content.slice(0, markerMatch.index);
    return content.trim();
  } catch {
    return "";
  }
}

/**
 * Extract the exit code from the tmux output file marker.
 * Returns undefined if no marker or invalid.
 */
function _readTmuxExitCode(promiseId: string): number | undefined {
  const outFile = `/tmp/promise-${promiseId}.out`;
  try {
    if (!existsSync(outFile)) return undefined;
    const content = readFileSync(outFile, "utf-8");
    const match = content.match(/---PROMISE-DONE:(\d+)---(\n?)$/);
    if (match) return parseInt(match[1], 10);
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Run a command in a new tmux session. Writes a temp script to avoid
 * shell-escaping nightmares, pipes output through tee to a capture file.
 * The session stays open (exec bash) so the user can attach and inspect.
 */
function _runInTmux(promise: BackgroundPromise): void {
  if (!promise.command) {
    _runDirect(promise);
    return;
  }

  const sessionName = _toTmuxName(promise);
  const outFile = `/tmp/promise-${promise.id}.out`;
  const scriptFile = `/tmp/promise-${promise.id}.sh`;
  _tmuxSessions.set(promise.id, sessionName);

  // Write a temp script that runs the command in a subshell (so 'exit' inside
  // the command doesn't kill the script before the marker is written), tees
  // output to a capture file, and stays open for user inspection.
  const script = `#!/bin/bash
(
stdbuf -oL sh -c '${promise.command.replace(/'/g, "'\\''")}'
) 2>&1 | stdbuf -oL tee "${outFile}"
_ec=\${PIPESTATUS[0]}
echo "---PROMISE-DONE:\${_ec}---" >> "${outFile}"
echo ""
echo "┌──────────────────────────────────────────────────┐"
echo "│  Promise complete — you can close this pane.     │"
echo "└──────────────────────────────────────────────────┘"
exec bash
`;
  writeFileSync(scriptFile, script, "utf-8");
  try { execSync(`chmod +x "${scriptFile}"`, { stdio: "ignore" }); } catch {}

  // Launch in a detached tmux session
  try {
    execSync(`tmux new-session -d -s "${sessionName}" "bash ${scriptFile}" 2>/dev/null`, { stdio: "ignore" });
    promise.status = "running";
    promise.childPid = undefined; // tmux manages the process
    setPromise(promise);

    // Start polling for completion, progress, and status messages
    _startTmuxPolling(promise);

    _updateStatusBar();
  } catch (err) {
    // tmux failed — fall back to direct execution
    _tmuxSessions.delete(promise.id);
    try { unlinkSync(scriptFile); } catch {}
    _runDirect(promise);
  }
}

/** Start polling a running tmux promise for completion, progress, and status. */
function _startTmuxPolling(promise: BackgroundPromise): void {
  const sessionName = _tmuxSessions.get(promise.id);
  if (!sessionName) return;
  const outFile = `/tmp/promise-${promise.id}.out`;

  const pollInterval = setInterval(() => {
    const current = getPromise(promise.id);
    if (!current || current.status === "cancelled") {
      clearInterval(pollInterval);
      return;
    }

    try {
      if (existsSync(outFile)) {
        const content = readFileSync(outFile, "utf-8");

        // Scan for progress markers: PROMISE_PROGRESS:N
        const progressRegex = /PROMISE_PROGRESS:(\d+)/g;
        let progressMatch: RegExpExecArray | null;
        let lastProgressVal: number | undefined;
        while ((progressMatch = progressRegex.exec(content)) !== null) {
          lastProgressVal = parseInt(progressMatch[1], 10);
        }
        if (lastProgressVal !== undefined && !isNaN(lastProgressVal) && lastProgressVal >= 0 && lastProgressVal <= 100) {
          promise.progress = lastProgressVal;
          setPromise(promise);
        }

        // Extract last non-marker line for status message
        const lines = content.trim().split("\n").filter(l => {
          const t = l.trim();
          return t && !t.startsWith("---PROMISE-DONE") && !t.startsWith("PROMISE_PROGRESS") && !t.startsWith("\u2502");
        });
        if (lines.length > 0) {
          const lastLine = lines[lines.length - 1].trim();
          if (lastLine.length > 0 && lastLine.length < 80) {
            promise.statusMessage = lastLine;
            setPromise(promise);
          }
        }

        if (/---PROMISE-DONE:\d+---/.test(content)) {
          clearInterval(pollInterval);
          const exitCode = _readTmuxExitCode(promise.id);
          promise.status = exitCode === 0 ? "completed" : "failed";
          const rawOutput = _readTmuxOutput(promise.id);
          promise.result = { output: rawOutput.replace(/PROMISE_PROGRESS:\d+[\s\n]*/g, "").trim() };
          if (exitCode !== 0 && exitCode !== undefined) {
            promise.error = `Command exited with code ${exitCode}`;
          }
          promise.completedAt = Date.now();
          setPromise(promise);
          _updateStatusBar();
          runChainedPromise(promise);
        }
      }
    } catch {
      // File may be temporarily locked
    }
  }, 500);
}

/**
 * Direct spawn-based execution (original behavior, no tmux).
 */
function _runDirect(promise: BackgroundPromise): void {
  if (!promise.command) {
    promise.status = "failed";
    promise.error = "Missing command";
    promise.completedAt = Date.now();
    setPromise(promise);
    runChainedPromise(promise);
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
      const chunk = data.toString();
      // Scan for progress markers: PROMISE_PROGRESS:N (take last value in chunk)
      const progressRegex = /PROMISE_PROGRESS:(\d+)/g;
      let progressMatch: RegExpExecArray | null;
      let lastProgressVal: number | undefined;
      while ((progressMatch = progressRegex.exec(chunk)) !== null) {
        lastProgressVal = parseInt(progressMatch[1], 10);
      }
      if (lastProgressVal !== undefined && !isNaN(lastProgressVal) && lastProgressVal >= 0 && lastProgressVal <= 100) {
        promise.progress = lastProgressVal;
        setPromise(promise);
      }
      // Keep non-progress lines in output (filter out PROGRESS markers)
      const filtered = chunk.replace(/PROMISE_PROGRESS:\d+\n?/g, "").replace(/PROMISE_PROGRESS:\d+/g, "");
      output += filtered;
      // Track last line for footer status
      const lines = filtered.trim().split("\n");
      const lastLine = lines[lines.length - 1];
      if (lastLine && lastLine.length > 0 && lastLine.length < 80) {
        promise.statusMessage = lastLine.trim();
        setPromise(promise);
      }
    });

    proc.stderr?.on("data", (data: Buffer) => {
      output += data.toString();
    });

    new Promise<void>((resolve) => {
      proc.on("close", (code: number | null) => {
        if (promise.status !== "cancelled") {
          if (code === 0) {
            promise.status = "completed";
            promise.result = { output: output.trim() };
          } else {
            promise.status = "failed";
            promise.error = `Command exited with code ${code}`;
            promise.result = { output: output.trim() };
          }
        }
        promise.completedAt = Date.now();
        setPromise(promise);
        resolve();
      });

      proc.on("error", (err: Error) => {
        if (promise.status !== "cancelled") {
          promise.status = "failed";
          promise.error = err.message;
        }
        promise.completedAt = Date.now();
        setPromise(promise);
        resolve();
      });
    }).then(() => {
      runChainedPromise(promise);
    });
  } catch (err) {
    promise.status = "failed";
    promise.error = err instanceof Error ? err.message : String(err);
    promise.completedAt = Date.now();
    setPromise(promise);
    runChainedPromise(promise);
  }
}

// =============================================================================
// Shutdown Cleanup — cancel all promises when pi exits
// =============================================================================

/**
 * Cancel all running/pending promises — kills child processes, clears timers,
 * marks every promise as cancelled with reason "pi shutdown".
 * Iterates all promises since children are tracked in the same map.
 */
function cancelAllPromises(): void {
  for (const [, promise] of promises) {
    if (promise.status === "running" || promise.status === "pending") {
      // Kill child process
      if (promise.childPid) {
        try {
          process.kill(promise.childPid, "SIGTERM");
        } catch {
          // May have already exited
        }
      }
      // Abort in-flight fetch download
      const ac = _downloadControllers.get(promise.id);
      if (ac) { ac.abort(); _downloadControllers.delete(promise.id); }
      // Clear progress polling
      const timer = _progressTimers.get(promise.id);
      if (timer) {
        clearInterval(timer);
        _progressTimers.delete(promise.id);
      }
      // Clear child PID (won't survive reload)
      promise.childPid = undefined;
      // Don't change status or kill tmux sessions — reload reconnects them
    }
  }
  // Persist state for the next session to pick up
  _saveState();
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
        ];
        if (promise.result) {
          const resultStr =
            typeof promise.result === "object"
              ? JSON.stringify(promise.result, null, 2)
              : String(promise.result);
          lines.push(`Result: ${resultStr}`);
        }

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
          lines.push(`Partial result: ${JSON.stringify(promise.result)}`);
        }

        pi.sendMessage(
          {
            customType: "promise-completion",
            content: lines.join("\n"),
            display: true,
          },
          { triggerTurn: true, deliverAs: "followUp" }
        );
      } else if (promise.status === "cancelled") {
        const lines = [
          `\u23F1 Promise "${promise.name}" skipped!`,
          `\u2022 Type: ${promise.type}`,
          `\u2022 Reason: ${promise.error ?? "Cancelled"}`,
        ];
        // Show the parent chain for context
        for (const [, p] of promises) {
          if (p.thenPromiseId === promise.id) {
            const parentId = p.id;
            const parent = promises.get(parentId);
            if (parent) {
              lines.push(`Parent "${parent.name}" (${parent.id}) status: ${parent.status}`);
            }
            break;
          }
        }

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

      // Emit a lightweight status-update event too (no triggerTurn)
      // This lets agents that poll for changes see progress without a full notification
      try {
        if (promise.status === "running" && promise.subject) {
          // Use display=false so it doesn't interrupt the agent
          pi.sendMessage(
            {
              customType: "promise-status-update",
              content: `Promise "${promise.name}" is running: ${promise.subject}`,
              display: false,
            },
            { triggerTurn: false }
          );
        }
      } catch {
        // Session may no longer be active
      }
    } catch {
      // Session may no longer be active, ignore silently
    }
  };

  // ---- Status Bar: show promise info in footer, expandable widget -----
  let sessionCtx: { ui: any; theme: any } | undefined;

  pi.on("session_start", async (_event, ctx) => {
    sessionCtx = { ui: ctx.ui, theme: ctx.ui.theme };
    _loadState();
    _updateStatusBar(sessionCtx);
  });

  pi.on("session_shutdown", async () => {
    cancelAllPromises();
  });

  pi.registerShortcut("ctrl+shift+b", {
    description: "Toggle expanded promise status bar",
    handler: async (ctx) => {
      _expanded = !_expanded;
      _updateStatusBar({ ui: ctx.ui, theme: ctx.ui.theme });
      if (_expanded) {
        ctx.ui.notify("Promise status expanded \u2014 F4 to collapse", "info");
      } else {
        ctx.ui.notify("Promise status collapsed \u2014 F4 to expand", "info");
      }
    },
  });
  // F4 toggles expanded view (may be intercepted by some terminals)
  // Also available as /promises command
  pi.registerShortcut("f4", {
    description: "Toggle expanded promise status bar",
    handler: async (ctx) => {
      _expanded = !_expanded;
      _updateStatusBar({ ui: ctx.ui, theme: ctx.ui.theme });
      ctx.ui.notify(_expanded ? "Promise status expanded \u2014 F4 to collapse" : "Promise status collapsed \u2014 F4 to expand", "info");
    },
  });

let _promiseViewTimer: ReturnType<typeof setInterval> | null = null;
let _promiseViewId: string | null = null;

  pi.registerCommand("promise", {
    description: "/promise — toggle expanded view. /promise <N> — show promise #N's live output. /promise stop — close live view.",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();

      // Stop previous live view if running
      const stopView = () => {
        if (_promiseViewTimer) {
          clearInterval(_promiseViewTimer);
          _promiseViewTimer = null;
        }
        _promiseViewId = null;
        ctx.ui.setWidget("promise-view", undefined);
      };

      // Stop view
      if (arg === "stop") {
        stopView();
        ctx.ui.notify("Promise live view closed", "info");
        return;
      }

      // No args: toggle expanded view
      if (!arg) {
        // Stop any running live view first
        stopView();
        _expanded = !_expanded;
        _updateStatusBar({ ui: ctx.ui, theme: ctx.ui.theme });
        ctx.ui.notify(_expanded ? "Promise status expanded" : "Promise status collapsed", "info");
        return;
      }

      // Find promise by index (1-based root) or by ID/name
      const roots = collectRootPromises();
      let target: BackgroundPromise | undefined;
      const index = parseInt(arg, 10);
      if (!isNaN(index) && index >= 1 && index <= roots.length) {
        target = roots[index - 1];
      } else {
        target = Array.from(promises.values()).find(p => p.id.startsWith(arg) || p.name.toLowerCase().includes(arg));
      }

      if (!target) {
        ctx.ui.notify(`Promise not found: ${arg}`, "error");
        return;
      }

      if (target.status !== "running" && target.status !== "pending") {
        ctx.ui.notify(`Promise "${target.name}" is ${target.status}`, "warning");
        return;
      }

      // Find tmux session name
      const sessionName = _tmuxSessions.get(target.id);
      if (!sessionName) {
        ctx.ui.notify(`Promise "${target.name}" has no tmux session (ran directly)`, "warning");
        return;
      }

      // Stop any previous view
      stopView();
      _promiseViewId = target.id;

      // Show live tmux output in a widget below the editor
      const renderView = () => {
        try {
          const pane = execSync(`tmux capture-pane -t "${sessionName}" -p -S -30 2>/dev/null`, {
            stdio: "pipe", encoding: "utf-8", timeout: 2000
          }).trim();
          if (pane) {
            const lines = pane.split("\n").filter(l => !l.startsWith("\u2502") && !l.startsWith("---PROMISE-DONE") && l.trim());
            const last = lines.slice(-8);
            ctx.ui.setWidget("promise-view", [
              ctx.ui.theme.fg("accent", ctx.ui.theme.bold(` \u25B6 ${target!.name}`)),
              ...last.map(l => ctx.ui.theme.fg("text", "  " + l)),
              ctx.ui.theme.fg("dim", "  /promise stop"),
            ], { placement: "belowEditor" });
          }
        } catch {
          // Tmux may be unavailable
        }
      };

      renderView();
      _promiseViewTimer = setInterval(renderView, 1000);
      ctx.ui.notify(`Showing live output for "${target.name}" — /promise stop to close`, "info");
    },
  });

  // ---------------------------------------------------------------------
  // promise-create: Start async task in background
  // ---------------------------------------------------------------------
  pi.registerTool(
    defineTool({
      name: "promise-create",
      label: "Promise Create",
      description: "Start an async task in background. Returns immediately with a promise ID. You can continue working on other tasks while it runs. When the promise completes, you'll be automatically notified with the result. Supports chaining with 'then' parameter. Do NOT call promise-block-until-complete after this — the result auto-delivers.\n\nProgress tracking: If the command can report progress, add \"echo PROMISE_PROGRESS:\$i\" to each iteration. The footer will show a live block bar instead of the default circle animation. PROMISE_PROGRESS lines are auto-filtered from the final result.",
      promptSnippet: "Start a background task and keep working — results auto-deliver",
      promptGuidelines: [
        "DEFAULT TO USING PROMISES. If a task takes more than a couple seconds, fire promise-create and keep working on other things.",
        "You get a promiseId immediately and can continue other work without blocking — edit files, read code, answer questions, start more promises.",
        "When a promise completes, a 🔔 notification message is automatically delivered. You do NOT need to poll or await.",
        "Use the 'then' parameter to chain a command that runs automatically after the first completes.",
        "After creating a promise, work on DIFFERENT things — don't start the same work manually. The promise handles its task.",
        "If you have nothing else to do while a promise runs, it's fine to stop — the promise notification will wake you up when the result is ready.",
        "When a promise completion notification arrives, the result is ready to use. Act on it naturally — inspect the output, chain next steps, or report to the user.",
        "DEDUP: Use dedup=true + subject=... to avoid creating duplicate promises. If a promise with the same subject already exists (and hasn't failed), the existing promise's ID is returned instead of creating a new one.",
        "REPLACE: Use replace=true + subject=... to cancel an existing promise with the same subject and create a fresh one. This is the pattern for 're-run tests after code changes'.",
        "PROGRESS: HIGHLY SUGGESTED — If a command can report progress, add PROMISE_PROGRESS:N to your command (where N is 0-100). The promise will show a live block progress bar in the footer instead of the default circle animation. Example: `for i in \$(seq 0 100); do echo \"PROMISE_PROGRESS:\$i\"; \$COMMAND; done` — the PROGRESS: lines are automatically filtered from the final output.",
      ],
      parameters: Type.Object({
        download: Type.Optional(Type.String({ description: "URL to download" })),
        path: Type.Optional(Type.String({ description: "File path to save to" })),
        command: Type.Optional(Type.String({ description: "Shell command to execute in background" })),
        then: Type.Optional(Type.String({ description: "Command to run after this one completes (chain)" })),
        thenCondition: Type.Optional(Type.String({ description: "Chain condition: 'always' (default), 'on-success', or 'on-failure'" })),
        name: Type.Optional(Type.String({ description: "Optional name for this promise" })),
        subject: Type.Optional(Type.String({ description: "Semantic label for dedup/replace matching. Use with dedup=true to avoid duplicates, or replace=true to cancel-and-restart." })),
        dedup: Type.Optional(Type.Boolean({ description: "Skip creation if a promise with the same subject already exists (and hasn't failed). Returns the existing promise instead." })),
        replace: Type.Optional(Type.Boolean({ description: "Cancel any existing promise with the same subject before creating a new one. Use when re-running a task after changes." })),
      }),
      async execute(_toolCallId: string, args: {
        download?: string;
        path?: string;
        command?: string;
        then?: string;
        thenCondition?: string;
        name?: string;
        subject?: string;
        dedup?: boolean;
        replace?: boolean;
      }, _signal?: AbortSignal): Promise<any> {
        // ---- Dedup / Replace: Check for existing promise with same subject ----
        if (args.subject) {
          if (args.replace) {
            // REPLACE: Cancel existing promise with same subject, then create new
            const existing = findPromiseBySubject(args.subject);
            if (existing && (existing.status === "pending" || existing.status === "running")) {
              existing.status = "cancelled";
              existing.error = "Replaced by new promise with same subject";
              existing.completedAt = Date.now();
              if (existing.childPid) {
                try { process.kill(existing.childPid, "SIGTERM"); } catch {}
              }
              const existingDownloadAc = _downloadControllers.get(existing.id);
              if (existingDownloadAc) { existingDownloadAc.abort(); _downloadControllers.delete(existing.id); }
              const timer = _progressTimers.get(existing.id);
              if (timer) { clearInterval(timer); _progressTimers.delete(existing.id); }
              _killTmuxSession(existing.id);
              // Cascade cancellation to children
              let current = existing;
              while (current.thenPromiseId) {
                const child = getPromise(current.thenPromiseId);
                if (!child) break;
                if (child.status === "completed" || child.status === "failed") break;
                child.status = "cancelled";
                child.error = `Parent ${current.id} was cancelled (replaced)`;
                child.completedAt = Date.now();
                if (child.childPid) { try { process.kill(child.childPid, "SIGTERM"); } catch {} }
                const childDownloadAc = _downloadControllers.get(child.id);
                if (childDownloadAc) { childDownloadAc.abort(); _downloadControllers.delete(child.id); }
                const childTimer = _progressTimers.get(child.id);
                if (childTimer) { clearInterval(childTimer); _progressTimers.delete(child.id); }
                _killTmuxSession(child.id);
                setPromise(child);
                current = child;
              }
              setPromise(existing);
              notifyCompletion(existing);
            }
          } else if (args.dedup) {
            // DEDUP: Return existing promise if same subject exists and not failed
            const existing = findPromiseBySubject(args.subject);
            if (existing && existing.status !== "failed" && existing.status !== "cancelled") {
              const statusDesc = existing.status === "completed" ? "already completed" : `currently ${existing.status}`;
              const text = `Dedup: promise with subject "${args.subject}" ${statusDesc} — returning existing ${existing.id}`;
              return {
                content: [{ type: "text", text: `${text}` }],
                details: {
                  promiseId: existing.id,
                  name: existing.name,
                  subject: existing.subject,
                  type: existing.type,
                  status: existing.status as string,
                  dedup: true,
                  replace: false,
                  existingResult: existing.result,
                  previousResult: existing.previousResult,
                  willChain: false,
                  thenCondition: undefined as (ThenCondition | undefined),
                  error: existing.error ?? "",
                },
              };
            }
          }
        }

        if (_signal?.aborted) {
          return {
            content: [{ type: "text", text: "Promise creation aborted by caller" }],
            details: { promiseId: "", name: "", subject: "", type: "command", status: "cancelled", dedup: false, replace: false, existingResult: undefined, previousResult: undefined, willChain: false, thenCondition: undefined, error: "Aborted" },
            isError: true
          };
        }

        const isDownload = !!args.download;
        const name = args.name ?? (isDownload ? "download" : "command");

        const thenCondition = (args.thenCondition as ThenCondition | undefined) ?? "always";

        const promise: BackgroundPromise = {
          id: generatePromiseId(),
          name,
          subject: args.subject,
          type: isDownload ? "download" : "command",
          status: "pending",
          url: args.download,
          targetPath: args.path,
          command: args.command,
          thenCommand: args.then,
          thenName: args.then ? `then-${name}` : undefined,
          thenCondition: args.then ? thenCondition : undefined,
          lastKnownSize: 0,
          createdAt: Date.now(),
        };

        // Pre-create child immediately so promise-then always finds the
        // correct terminal via the thenPromiseId linked list — never races
        // on mutable thenCommand/thenDownload on an intermediate node.
        if (args.then) {
          const child: BackgroundPromise = {
            id: generatePromiseId(),
            name: `then-${name}`,
            type: "command",
            status: "pending",
            command: args.then,
            lastKnownSize: 0,
            createdAt: Date.now(),
          };
          promise.thenPromiseId = child.id;
          setPromise(child);
        }

        setPromise(promise);

        if (isDownload) {
          runDownload(promise);
        } else {
          runCommand(promise);
        }

        // Update status bar for the new promise
        _updateStatusBar();

        const chainInfo = args.then
          ? ` (will chain to: ${args.then} [${thenCondition}])`
          : "";
        const subjectInfo = promise.subject
          ? ` — ${promise.subject}`
          : "";
        const replaceInfo = args.replace
          ? " — replaced previous run"
          : "";
        const commandDisplay = promise.command?.slice(0, 100) ?? promise.url ?? "";
        const text = `Started ${promise.type}: ${promise.id}${subjectInfo}${chainInfo}${replaceInfo}`;

        return {
          content: [{ type: "text", text: `${text}` }],
          details: {
            promiseId: promise.id,
            name: promise.name,
            subject: promise.subject,
            type: promise.type,
            status: "started",
            willChain: !!args.then,
            thenCondition: thenCondition as (ThenCondition | undefined),
            dedup: false,
            replace: args.replace ?? false,
            existingResult: undefined,
            previousResult: undefined,
            error: "",
          },
        };
      },
    })
  );

  // ---------------------------------------------------------------------
  // promise-block-until-complete: Block until done (last resort — prefer promise-then)
  // ---------------------------------------------------------------------
  pi.registerTool(
    defineTool({
      name: "promise-block-until-complete",
      label: "Promise Block Until Complete",
      description: "⚠️ DEPRECATED — Do not use. Results auto-deliver. Trust the notification. Never wait for a promise; always keep working and let the result wake you up.",
      promptSnippet: "⚠️ DEPRECATED — never block on a promise, trust auto-delivery",
      promptGuidelines: [
        "⚠️ Do NOT call this tool unless you have absolutely no other work to do.",
        "Results auto-deliver as messages — trust auto-delivery instead of blocking.",
        "If you need to chain work after a promise, use promise-then(promiseId, command) instead.",
        "This tool blocks your progress — promise-then keeps you working.",
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
      }, _signal?: AbortSignal) {
        const promise = getPromise(args.promiseId);

        if (!promise) {
          return {
            content: [{ type: "text", text: `Promise not found: ${args.promiseId}` }],
            details: { success: false, error: `Promise not found: ${args.promiseId}` },
            isError: true
          };
        }

        // Mark as explicitly blocked BEFORE returning — notifyCompletion
        // checks this set and suppresses the auto-notification to avoid
        // a duplicate follow-up turn when the LLM already has the result.
        _awaitedPromises.add(args.promiseId);

        if (promise.status === "completed") {
          // Include result in details for agent use
          return { 
            content: [{ type: "text", text: `Promise completed
Tip: Never block on a promise — results auto-deliver. Instead, use promise-then(promiseId="${promise.id}", command=..., condition="on-success") to chain follow-up work automatically while you keep working.` }], 
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

        if (_signal?.aborted) {
          return {
            content: [{ type: "text", text: "Aborted by caller" }],
            details: { success: false, error: "Aborted", result: undefined, previousResult: undefined },
            isError: true
          };
        }

        if (promise.type === "download") {
          return await waitForDownload(promise, args);
        }

        // For commands, simple poll with result passthrough
        while (getPromise(args.promiseId)?.status === "running") {
          if (_signal?.aborted) {
            return {
              content: [{ type: "text", text: "Aborted by caller" }],
              details: { success: false, error: "Aborted", result: undefined, previousResult: undefined },
              isError: true
            };
          }
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
        
        let text = `${promise.name} (${promise.type}): ${promise.status}`;
        if (promise.lastKnownSize) {
          if (promise.totalSize && promise.totalSize > 0) {
            const pct = Math.round((promise.lastKnownSize / promise.totalSize) * 100);
            text += ` - ${pct}% (${promise.lastKnownSize} bytes / ${promise.totalSize} bytes)`;
          } else {
            text += ` - ${promise.lastKnownSize} bytes`;
          }
        }
        
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
  // promises-list: List all tracked promises (tree view)
  // ---------------------------------------------------------------------
  pi.registerTool(
    defineTool({
      name: "promises-list",
      label: "Promises List",
      description: "List all tracked background promises as a tree showing parent-child chain relationships.",
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

        const treeLines = buildAllChainsText();
        const orphaned = all.filter(p => {
          // Not a root and not referenced by any parent — orphan
          if (collectRootPromises().includes(p)) return false;
          for (const [, q] of promises) {
            if (q.thenPromiseId === p.id) return false;
          }
          return true;
        });
        if (orphaned.length > 0) {
          treeLines.push("");
          treeLines.push(`Orphaned (${orphaned.length}):`);
          for (const o of orphaned) {
            treeLines.push(`  ${_STATUS_GLYPH[o.status] || "?"} ${o.id}: ${o.name} - ${o.status}`);
          }
        }

        return {
          content: [{ type: "text", text: treeLines.join("\n") }],
          details: {
            count: all.length,
            tree: buildAllChainsText(),
            promises: all.map((p) => ({
              promiseId: p.id,
              name: p.name,
              subject: p.subject,
              type: p.type,
              status: p.status,
              hasResult: !!p.result,
              parentId: (() => {
                for (const [, q] of promises) {
                  if (q.thenPromiseId === p.id) return q.id;
                }
                return undefined;
              })(),
              childId: p.thenPromiseId,
              condition: p.thenCondition,
              createdAt: p.createdAt,
            }))
          } as any,
        };
      },
    })
  );

  // ---------------------------------------------------------------------
  // promise-graph: Visualise chain relationships
  // ---------------------------------------------------------------------
  pi.registerTool(
    defineTool({
      name: "promise-graph",
      label: "Promise Graph",
      description: "Show the chain tree for a specific promise or all chains. Returns a structured view of parent-child relationships.",
      parameters: Type.Object({
        promiseId: Type.Optional(Type.String({ description: "Show chain for a specific promise ID (shows its full chain). If omitted, shows all root chains." })),
      }),
      async execute(_toolCallId: string, args: { promiseId?: string }) {
        if (args.promiseId) {
          const target = getPromise(args.promiseId);
          if (!target) {
            return {
              content: [{ type: "text", text: `Promise not found: ${args.promiseId}` }],
              details: { found: false },
              isError: true
            };
          }

          // Find the root of this promise's chain
          let root = target;
          let found: BackgroundPromise | undefined;
          do {
            found = undefined;
            for (const [, p] of promises) {
              if (p.thenPromiseId === root.id) {
                root = p;
                found = p;
                break;
              }
            }
          } while (found);

          const chainLines = buildChainText(root);
          const chainPath = buildChainPathText(root);
          // Find depth of target in chain
          let depth = 0;
          let cur: BackgroundPromise | undefined = root;
          while (cur && cur.id !== target.id) {
            cur = cur.thenPromiseId ? (promises.get(cur.thenPromiseId) ?? undefined) : undefined;
            depth++;
          }

          return {
            content: [{ type: "text", text: [
              `Chain for ${target.id} (${target.name}):`,
              "",
              ...chainLines,
              "",
              `Path: ${chainPath}`,
              `Depth: ${depth} | Status: ${target.status}`,
            ].join("\n") }],
            details: {
              found: true,
              targetId: target.id,
              targetName: target.name,
              targetStatus: target.status,
              depth,
              chainPath,
              chain: (() => {
                const nodes: Array<{ id: string; name: string; status: string; condition?: string }> = [];
                let c: BackgroundPromise | undefined = root;
                while (c) {
                  nodes.push({
                    id: c.id,
                    name: c.name,
                    status: c.status,
                    condition: c.thenCondition,
                  });
                  c = c.thenPromiseId ? (promises.get(c.thenPromiseId) ?? undefined) : undefined;
                }
                return nodes;
              })(),
            } as any,
          };
        }

        // Show all chains
        const treeLines = buildAllChainsText();
        const roots = collectRootPromises();
        const chainPaths = roots.map((r, i) => `${i + 1}. ${buildChainPathText(r)}`);

        return {
          content: [{ type: "text", text: [
            "Promise chain forest:",
            "",
            ...treeLines,
            "",
            "Compact paths:",
            ...chainPaths,
          ].join("\n") }],
          details: {
            count: roots.length,
            forest: roots.map(r => ({
              rootId: r.id,
              rootName: r.name,
              path: buildChainPathText(r),
              nodes: (() => {
                const nodes: Array<{ id: string; name: string; status: string; condition?: string }> = [];
                let c: BackgroundPromise | undefined = r;
                while (c) {
                  nodes.push({
                    id: c.id,
                    name: c.name,
                    status: c.status,
                    condition: c.thenCondition,
                  });
                  c = c.thenPromiseId ? (promises.get(c.thenPromiseId) ?? undefined) : undefined;
                }
                return nodes;
              })(),
            })),
          } as any,
        };
      },
    })
  );

  // ---------------------------------------------------------------------
  // promise-rechain: Re-attach a cancelled/failed promise to a new parent
  // ---------------------------------------------------------------------
  pi.registerTool(
    defineTool({
      name: "promise-rechain",
      label: "Promise Rechain",
      description: "Re-attach a cancelled or failed promise so it runs after a different parent. Creates a new promise with the same command and attaches it to the target's chain. The original cancelled/failed promise remains in history.",
      parameters: Type.Object({
        fromPromiseId: Type.String({ description: "ID of the cancelled/failed promise whose command should be retried" }),
        toPromiseId: Type.String({ description: "ID of the promise to chain after (the new parent)" }),
        condition: Type.Optional(Type.String({ description: "Condition for the re-chained step: 'always' (default), 'on-success', or 'on-failure'" })),
        name: Type.Optional(Type.String({ description: "Optional name for the retried promise. Defaults to original name." })),
        subject: Type.Optional(Type.String({ description: "Optional subject for the retried promise" })),
      }),
      async execute(_toolCallId: string, args: {
        fromPromiseId: string;
        toPromiseId: string;
        condition?: string;
        name?: string;
        subject?: string;
      }) {
        // ---- Validate source ----
        const fromPromise = getPromise(args.fromPromiseId);
        if (!fromPromise) {
          return { content: [{ type: "text", text: `fromPromise not found: ${args.fromPromiseId}` }], details: { success: false, error: "fromPromise not found" } as any, isError: true };
        }
        if (fromPromise.status === "running" || fromPromise.status === "pending") {
          return { content: [{ type: "text", text: `Cannot re-chain a ${fromPromise.status} promise. Cancel it first.` }], details: { success: false, error: "Source promise is still running" } as any, isError: true };
        }
        if (!fromPromise.command && !fromPromise.url) {
          return { content: [{ type: "text", text: "Source promise has no command or download to retry." }], details: { success: false, error: "No command/download to retry" } as any, isError: true };
        }

        // ---- Validate target ----
        const toPromise = getPromise(args.toPromiseId);
        if (!toPromise) {
          return { content: [{ type: "text", text: `toPromise not found: ${args.toPromiseId}` }], details: { success: false, error: "toPromise not found" } as any, isError: true };
        }

        // ---- Validate condition ----
        const validConditions = ["always", "on-success", "on-failure"];
        const condition = (args.condition ?? "always") as ThenCondition;
        if (!validConditions.includes(condition)) {
          return { content: [{ type: "text", text: `Invalid condition: ${args.condition}. Use: always, on-success, on-failure` }], details: { success: false, error: "Invalid condition" } as any, isError: true };
        }

        // ---- Detach fromPromise from its old parent (if any) ----
        for (const [, p] of promises) {
          if (p.thenPromiseId === fromPromise.id) {
            p.thenPromiseId = undefined;
            setPromise(p);
            break;
          }
        }

        // ---- Find terminal of target chain ----
        const terminal = findTerminalPromise(toPromise);

        // ---- Attach a new promise with same command to terminal ----
        const isDownload = !!fromPromise.url;
        terminal.thenCommand = isDownload ? undefined : fromPromise.command;
        terminal.thenDownload = isDownload ? fromPromise.url : undefined;
        terminal.thenPath = fromPromise.targetPath;
        terminal.thenName = args.name ?? fromPromise.name;
        terminal.thenCondition = condition;
        // Propagate subject to the chained promise if provided
        if (args.subject) {
          terminal.thenSubject = args.subject;
        } else if (fromPromise.subject) {
          terminal.thenSubject = fromPromise.subject;
        }
        setPromise(terminal);

        // ---- If terminal is settled, run chained promise immediately ----
        const isSettled = terminal.status === "completed" || terminal.status === "failed";
        if (isSettled) {
          runChainedPromise(terminal);
        }

        _updateStatusBar();

        // ---- Build response with chain context ----
        // Find root of target's chain
        let root = toPromise;
        let found: BackgroundPromise | undefined;
        do {
          found = undefined;
          for (const [, p] of promises) {
            if (p.thenPromiseId === root.id) {
              root = p;
              found = p;
              break;
            }
          }
        } while (found);

        const chainLines = buildChainText(root, terminal.id);
        const chainPath = buildChainPathText(root);

        return {
          content: [{ type: "text", text: [
            `Re-chained "${fromPromise.name}" after ${terminal.id} (condition: ${condition})`,
            "",
            ...chainLines,
            "",
            `Path: ${chainPath}`,
          ].join("\n") }],
          details: {
            success: true,
            error: "",
            fromPromiseId: fromPromise.id,
            fromPromiseName: fromPromise.name,
            toPromiseId: toPromise.id,
            toPromiseName: toPromise.name,
            terminalId: terminal.id,
            condition,
            chainPath,
          } as any,
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
        // Kill child process if still running
        if (promise.childPid) {
          try {
            process.kill(promise.childPid, "SIGTERM");
          } catch {
            // Process may have already exited
          }
        }
        // Abort in-flight fetch download
        const downloadAc = _downloadControllers.get(promise.id);
        if (downloadAc) { downloadAc.abort(); _downloadControllers.delete(promise.id); }
        // Clean up progress polling timer
        const timer = _progressTimers.get(promise.id);
        if (timer) {
          clearInterval(timer);
          _progressTimers.delete(promise.id);
        }
        // Kill tmux session if running in one
        _killTmuxSession(promise.id);
        setPromise(promise);

        // Cascade cancellation to all children in the chain
        let current = promise;
        while (current.thenPromiseId) {
          const child = getPromise(current.thenPromiseId);
          if (!child) break;
          if (child.status === "completed" || child.status === "failed") break;
          child.status = "cancelled";
          child.error = `Parent ${current.id} was cancelled`;
          child.completedAt = Date.now();
          if (child.childPid) {
            try { process.kill(child.childPid, "SIGTERM"); } catch {}
          }
          const childDownloadAc = _downloadControllers.get(child.id);
          if (childDownloadAc) { childDownloadAc.abort(); _downloadControllers.delete(child.id); }
          const childTimer = _progressTimers.get(child.id);
          if (childTimer) {
            clearInterval(childTimer);
            _progressTimers.delete(child.id);
          }
          _killTmuxSession(child.id);
          setPromise(child);
          current = child;
        }

        // Update status bar after cancellation
        _updateStatusBar();
        
        return { 
          content: [{ type: "text", text: `Cancelled: ${promise.id}` }], 
          details: { success: true, error: "" }
        };
      },
    })
  );

  // ---------------------------------------------------------------------
  // promise-then: Chain a task to run after an existing promise completes
  // ---------------------------------------------------------------------
  pi.registerTool(
    defineTool({
      name: "promise-then",
      label: "Promise Then",
      description: "Chain a command or download to run after an existing promise completes. Follows the chain to the end — multiple then calls create a sequence. If the target promise is already completed, the chained task runs immediately (subject to condition). Supports conditional execution with always, on-success, on-failure.",
      promptSnippet: "Chain a task after an existing promise — no blocking needed",
      promptGuidelines: [
        "Use promise-then to chain a task after a previously created promise. This is PREFERRED over promise-await — you don't block, the chain auto-executes.",
        "Multiple promise-then calls on the same promise create a sequential chain (each appends at the end).",
        "Use condition='on-success' or condition='on-failure' to control when the chain runs.",
        "If the target promise is already completed, the chained task runs immediately (subject to condition).",
        "Use promise-then instead of promise-block-until-complete whenever possible. Let the chain handle sequencing while you work on other things.",
        "After chaining, run promise-graph(promiseId=...) to inspect the chain structure and verify it's what you intended.",
      ],
      parameters: Type.Object({
        promiseId: Type.String({ description: "ID of an existing promise (from promise-create)" }),
        command: Type.Optional(Type.String({ description: "Shell command to run after the target promise completes" })),
        download: Type.Optional(Type.String({ description: "URL to download after the target promise completes" })),
        path: Type.Optional(Type.String({ description: "File path to save download to (required when using download)" })),
        name: Type.Optional(Type.String({ description: "Optional name for this chained promise" })),
        condition: Type.Optional(Type.String({ description: "When to run: 'always' (default), 'on-success', or 'on-failure'" })),
        subject: Type.Optional(Type.String({ description: "Semantic description of what this chained promise handles" })),
      }),
      async execute(_toolCallId: string, args: {
        promiseId: string;
        command?: string;
        download?: string;
        path?: string;
        name?: string;
        condition?: string;
        subject?: string;
      }) {
        // ---- Validate target ----
        const promise = getPromise(args.promiseId);
        if (!promise) {
          return { content: [{ type: "text", text: `Promise not found: ${args.promiseId}` }], details: { success: false, error: `Promise not found: ${args.promiseId}` } as any, isError: true };
        }
        if (promise.status === "cancelled") {
          return { content: [{ type: "text", text: "Cannot chain to cancelled promise" }], details: { success: false, error: "Promise is cancelled" } as any, isError: true };
        }
        if (!args.command && !args.download) {
          return { content: [{ type: "text", text: "Either command or download must be provided" }], details: { success: false, error: "Missing command or download" } as any, isError: true };
        }
        if (args.command && args.download) {
          return { content: [{ type: "text", text: "Provide either command or download, not both" }], details: { success: false, error: "Both command and download provided" } as any, isError: true };
        }
        if (args.download && !args.path) {
          return { content: [{ type: "text", text: "path is required when downloading" }], details: { success: false, error: "Missing path for download" } as any, isError: true };
        }

        const validConditions = ["always", "on-success", "on-failure"];
        const condition = (args.condition ?? "always") as ThenCondition;
        if (!validConditions.includes(condition)) {
          return { content: [{ type: "text", text: `Invalid condition: ${args.condition}. Use: always, on-success, on-failure` }], details: { success: false, error: `Invalid condition: ${args.condition}` } as any, isError: true };
        }

        // ---- Walk chain to find terminal (last) promise ----
        const terminal = findTerminalPromise(promise);

        // ---- Attach new chain to terminal ----
        terminal.thenCommand = args.command;
        terminal.thenDownload = args.download;
        terminal.thenPath = args.path;
        terminal.thenName = args.name ?? `then-${terminal.name}`;
        terminal.thenCondition = condition;
        // Propagate subject to the chained promise
        if (args.subject) {
          terminal.thenSubject = args.subject;
        }
        setPromise(terminal);

        // ---- If terminal is already settled, run chained task immediately ----
        const isSettled = terminal.status === "completed" || terminal.status === "failed" || terminal.status === "cancelled";
        if (isSettled) {
          runChainedPromise(terminal);
        }

        _updateStatusBar();

        const actionType = args.download ? "download" : "command";

        // ---- Build chain context for response ----
        // Find root of target's chain for visualization
        let root = promise;
        let foundAncestor: BackgroundPromise | undefined;
        do {
          foundAncestor = undefined;
          for (const [, p] of promises) {
            if (p.thenPromiseId === root.id) {
              root = p;
              foundAncestor = p;
              break;
            }
          }
        } while (foundAncestor);

        const chainPath = buildChainPathText(root);
        const chainLines = buildChainText(root, terminal.id);

        return {
          content: [{ type: "text", text: [
            `Chained ${actionType} "${args.name ?? args.command ?? args.download}" after ${terminal.id} (condition: ${condition})`,
            "",
            ...chainLines,
            "",
            `Path: ${chainPath}`,
          ].join("\n") }],
          details: {
            success: true,
            error: "",
            parentId: terminal.id,
            command: args.command,
            download: args.download,
            path: args.path,
            name: args.name,
            condition,
            chainPath,
            chainNodes: (() => {
              const nodes: Array<{ id: string; name: string; status: string }> = [];
              let c: BackgroundPromise | undefined = root;
              while (c) {
                nodes.push({ id: c.id, name: c.name, status: c.status });
                c = c.thenPromiseId ? (promises.get(c.thenPromiseId) ?? undefined) : undefined;
              }
              return nodes;
            })(),
          } as any,
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

// Exported for testing
export { findTerminalPromise, collectRootPromises, _isTmuxAvailable, _toTmuxName, _killTmuxSession, _readTmuxOutput, _readTmuxExitCode };