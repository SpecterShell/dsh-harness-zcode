/** Selects recently touched files and budgets their authorized contents for post-compaction context. */

import { isAbsolute, resolve } from "node:path";

import type {
  RestoreCandidate,
  RestoreEntry,
  RestoreRead,
  RestoreState,
  RestoreStateEntry,
} from "./types.ts";

export const RESTORE_MAX_FILES = 5;
export const RESTORE_MAX_FILE_TOKENS = 5_000;
export const RESTORE_MAX_TOTAL_TOKENS = 50_000;
export const RESTORE_ALWAYS_EXCLUDED_PATH_MARKERS = [
  "/.codex/memories/",
  "/docs/superpowers/plans/",
  "/.git/",
] as const;

/**
 * Ranks eligible tool touches after removing excluded and already preserved paths. Selection alone grants no read permission.
 * @param state - File observations collected from tool use.
 * @param options - File limit, exclusions and base directory for relative exclusions.
 */
export function selectRestoreCandidates(
  state: RestoreState,
  options: {
    readonly maxFiles?: number;
    readonly excludedPaths?: readonly string[];
    readonly preservedPaths?: readonly string[];
    readonly workingDirectory?: string;
  } = {},
): RestoreCandidate[] {
  const excluded = new Set(
    [...(options.excludedPaths ?? []), ...(options.preservedPaths ?? [])].map((path) =>
      /**
       * Resolves a candidate or exclusion to an absolute comparison key.
       * @param path - Absolute or relative file path.
       * @param workingDirectory - Base for relative paths, defaulting to the process directory.
       */
      normalizePath(path, options.workingDirectory),
    ),
  );
  return [...state.values()]
    .filter(
      (entry) =>
        entry.sourceTool === "read" ||
        entry.sourceTool === "write" ||
        entry.sourceTool === "edit",
    )
    .filter((entry) => !isAlwaysExcluded(entry.path))
    .filter((entry) => !excluded.has(normalizePath(entry.path)))
    .sort((left, right) => restoreRecency(right) - restoreRecency(left))
    .slice(0, options.maxFiles ?? RESTORE_MAX_FILES)
    .map((entry) => ({ ...entry }));
}

/**
 * Skips denied or missing reads, substitutes references for oversized files and enforces the total token budget.
 * @param candidates - Selected files in priority order.
 * @param reads - Authorization and read outcomes aligned by candidate index.
 * @param options - Per-file and aggregate token limits and optional estimator.
 */
export function buildRestoreEntries(
  candidates: readonly RestoreCandidate[],
  reads: readonly RestoreRead[],
  options: {
    readonly maxFileTokens?: number;
    readonly maxTotalTokens?: number;
    readonly estimateTokens?: (text: string) => number;
  } = {},
): { entries: RestoreEntry[]; state: Map<string, RestoreStateEntry> } {
  const maxFileTokens = options.maxFileTokens ?? RESTORE_MAX_FILE_TOKENS;
  const maxTotalTokens = options.maxTotalTokens ?? RESTORE_MAX_TOTAL_TOKENS;
  const estimate = options.estimateTokens ?? estimateTokens;
  const entries: RestoreEntry[] = [];
  const nextState = new Map<string, RestoreStateEntry>();
  let totalTokens = 0;

  candidates.forEach((candidate, index) => {
    const read = reads[index];
    if (!read || read.type === "denied" || read.type === "missing") return;
    const content =
      read.type === "too-large"
        ? referenceText(candidate.path)
        : read.text;
    const contentTokens = estimate(content);
    const entry =
      read.type === "too-large" || contentTokens > maxFileTokens
        ? {
            path: candidate.path,
            text: referenceText(candidate.path),
            kind: "reference" as const,
            tokens: estimate(referenceText(candidate.path)),
            ...(read.type === "content" ? { isPartialView: true } : {}),
          }
        : {
            path: candidate.path,
            text: content,
            kind: "content" as const,
            tokens: contentTokens,
          };
    if (totalTokens + entry.tokens > maxTotalTokens) return;
    totalTokens += entry.tokens;
    entries.push(entry);
    if (read.type === "content") {
      nextState.set(normalizePath(candidate.path), {
        ...candidate,
        ...(entry.kind === "reference" ? { isPartialView: true } : {}),
      });
    }
  });

  return { entries, state: nextState };
}

/**
 * Builds a reminder directing the model to request a fresh read for oversized contents.
 * @param path - File named in the reminder.
 */
function referenceText(path: string): string {
  return `Note: ${path} was read before the last conversation was summarized, but the contents are too large to include. Use Read tool if you need to access it.`;
}

function normalizePath(path: string, workingDirectory?: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(workingDirectory ?? process.cwd(), path);
}

/**
 * Checks directory markers with normalized separators.
 * @param path - Candidate file path.
 */
function isAlwaysExcluded(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return RESTORE_ALWAYS_EXCLUDED_PATH_MARKERS.some((marker) => normalized.includes(marker));
}

/**
 * Ranks replayed observations by touch time and fresh observations by file modification time when available.
 * @param entry - Observation being ranked.
 */
function restoreRecency(entry: RestoreStateEntry): number {
  return entry.restoredFromSession ? entry.touchedAt : (entry.mtimeMs ?? entry.touchedAt);
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
