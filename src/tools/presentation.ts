/**
 * Native tool-card metadata projections for the capitalized ZCode tools.
 *
 * These helpers only consume the canonical tool value. They never read the
 * filesystem or copy complete hidden file state into the session log.
 */
import { structuredPatch } from "diff";

/** Maximum serialized size of one persisted presentation metadata value. */
export const PRESENTATION_META_MAX_BYTES = 64 * 1024;

type PresentationJson =
  | null
  | boolean
  | number
  | string
  | PresentationJson[]
  | { [key: string]: PresentationJson };

interface FileDiff extends Record<string, PresentationJson> {
  path: string;
  oldText: string | null;
  newText: string;
}

interface ReadValue {
  filePath: string;
  content: string;
  numLines: number;
  startLine: number;
  totalLines: number;
}

interface WriteValue {
  type: "create" | "update";
  filePath: string;
  content: string;
  originalFile: string | null;
}

interface EditValue {
  filePath: string;
  diffs: FileDiff[];
}

interface GlobValue {
  filenames: string[];
  totalFiles: number;
  truncated: boolean;
}

interface GrepValue {
  mode: "content" | "files_with_matches" | "count";
  filenames: string[];
  cardFiles?: SearchFileMatches[];
  numMatches?: number;
  truncated: boolean;
}

interface SearchLineMatch extends Record<string, PresentationJson> {
  lineNumber: number;
  line: string;
}

interface SearchFileMatches extends Record<string, PresentationJson> {
  path: string;
  matches: SearchLineMatch[];
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function withinBudget<T>(value: T): T | Record<string, never> {
  return serializedBytes(value) <= PRESENTATION_META_MAX_BYTES ? value : {};
}

/**
 * Keeps the largest leading item window whose complete metadata stays within
 * the persistence budget. Dropping from the tail preserves result order.
 */
function boundedPrefix<T, M>(items: readonly T[], build: (kept: T[]) => M): M {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (serializedBytes(build(items.slice(0, middle))) <= PRESENTATION_META_MAX_BYTES) low = middle;
    else high = middle - 1;
  }
  return build(items.slice(0, low));
}

/**
 * Mirrors the native file tool's contextual hunk projection.
 *
 * Persisted metadata contains three context lines around each applied hunk.
 */
export function computeHunkDiffs(path: string, before: string, after: string): FileDiff[] {
  const patch = structuredPatch("", "", before, after, undefined, undefined, { context: 3 });
  const diffs: FileDiff[] = [];
  for (const hunk of patch.hunks) {
    const oldLines: string[] = [];
    const newLines: string[] = [];
    for (const line of hunk.lines) {
      if (line.startsWith("\\")) continue;
      const text = line.slice(1);
      if (line.startsWith("-")) oldLines.push(text);
      else if (line.startsWith("+")) newLines.push(text);
      else {
        oldLines.push(text);
        newLines.push(text);
      }
    }
    diffs.push({
      path,
      oldText: oldLines.length > 0 ? oldLines.join("\n") : null,
      newText: newLines.join("\n"),
    });
  }
  return diffs;
}

/** Project a bounded native read-card value from the existing numbered text. */
export function readPresentationMeta(value: ReadValue) {
  const lines = value.numLines === 0
    ? []
    : value.content.split("\n").map((rendered, index) => {
      const number = value.startLine + index;
      const prefix = `${number}\t`;
      return { number, text: rendered.startsWith(prefix) ? rendered.slice(prefix.length) : rendered };
    });
  return withinBudget({
    path: value.filePath,
    offset: value.startLine,
    lines,
    totalLines: value.totalLines,
  });
}

/** Project native write-card metadata, including a whole-file create diff. */
export function writePresentationMeta(value: WriteValue) {
  const diffs = value.originalFile === null
    ? [{ path: value.filePath, oldText: null, newText: value.content }]
    : computeHunkDiffs(value.filePath, value.originalFile, value.content);
  return withinBudget({
    operation: value.type,
    path: value.filePath,
    diffs,
  });
}

/** Project native edit-card metadata from the filesystem's actual before/after result. */
export function editPresentationMeta(value: EditValue) {
  return withinBudget({
    path: value.filePath,
    diffs: value.diffs,
  });
}

/** Project native path-search metadata without persisting uncapped shell output. */
export function globPresentationMeta(value: GlobValue) {
  return boundedPrefix(value.filenames, (paths) => ({
    shape: "paths" as const,
    paths,
    truncated: value.truncated || paths.length < value.filenames.length,
    total: value.totalFiles,
  }));
}

function grepFiles(value: GrepValue): SearchFileMatches[] | undefined {
  if (value.mode === "files_with_matches") {
    return value.filenames.map((path) => ({ path, matches: [] }));
  }
  if (value.mode === "content") return value.cardFiles;
  return undefined;
}

function flattenFiles(files: readonly SearchFileMatches[]): Array<{ path: string; match?: SearchLineMatch }> {
  return files.flatMap((file) =>
    file.matches.length === 0
      ? [{ path: file.path }]
      : file.matches.map((match) => ({ path: file.path, match })),
  );
}

function groupFiles(entries: readonly { path: string; match?: SearchLineMatch }[]): SearchFileMatches[] {
  const files: SearchFileMatches[] = [];
  const byPath = new Map<string, SearchFileMatches>();
  for (const entry of entries) {
    let file = byPath.get(entry.path);
    if (file === undefined) {
      file = { path: entry.path, matches: [] };
      byPath.set(entry.path, file);
      files.push(file);
    }
    if (entry.match !== undefined) file.matches.push(entry.match);
  }
  return files;
}

/** Project grouped native grep-card metadata from the already-rendered page. */
export function grepPresentationMeta(value: GrepValue) {
  const files = grepFiles(value);
  if (files === undefined) return {};
  const entries = flattenFiles(files);
  return boundedPrefix(entries, (kept) => ({
    shape: "matches" as const,
    files: groupFiles(kept),
    truncated: value.truncated || kept.length < entries.length,
    total: value.numMatches ?? entries.length,
  }));
}
