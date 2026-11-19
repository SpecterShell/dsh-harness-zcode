/** Discovers user and workspace instructions and renders their session reminders. */

import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { InstructionSource } from "./types.ts";

export const INSTRUCTION_BUDGET_BYTES = 100 * 1024;
export const DEFAULT_INSTRUCTION_CANDIDATES = ["AGENTS.md"] as const;

export interface DiscoverInstructionsInput {
  readonly cwd: string;
  readonly projectRoot?: string;
  readonly userHome?: string;
  readonly candidateFileNames?: readonly string[];
  readonly budgetBytes?: number;
}

/**
 * Loads the user file first, then at most one distinct workspace file.
 * @param input - Search origin, optional project boundary, candidate names and per-file byte budget.
 */
export async function discoverInstructions(
  input: DiscoverInstructionsInput,
): Promise<InstructionSource[]> {
  const candidates = input.candidateFileNames ?? DEFAULT_INSTRUCTION_CANDIDATES;
  const budgetBytes = input.budgetBytes ?? INSTRUCTION_BUDGET_BYTES;
  const sources: InstructionSource[] = [];

  if (candidates.includes("AGENTS.md")) {
    const userPath = join(input.userHome ?? homedir(), ".zcode", "AGENTS.md");
    const user = await readInstruction(userPath, "user", budgetBytes);
    if (user) sources.push(user);
  }

  const workspacePath = await findNearestInstruction(
    input.cwd,
    input.projectRoot,
    candidates,
  );
  if (workspacePath) {
    const workspace = await readInstruction(workspacePath, "workspace", budgetBytes);
    if (workspace && !sources.some((source) => resolve(source.path) === resolve(workspace.path))) {
      sources.push(workspace);
    }
  }

  return sources;
}

/**
 * Introduces the discovered files in their supplied order with scope and source path.
 * @param sources - Instruction files for the initial announcement.
 */
export function renderInstructionAnnouncement(sources: readonly InstructionSource[]): string {
  const preamble =
    "Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.";
  return [
    preamble,
    ...sources.map(
      (source) =>
        `Contents of ${source.path} (${source.scope === "user" ? "user's private global instructions for all projects" : "project instructions, checked into the codebase"}):\n\n${source.text.trim()}`,
    ),
  ].join("\n\n");
}

/**
 * Reports replacements and removals discovered after compaction.
 * @param changed - Files whose new contents supersede the earlier copy.
 * @param removed - Paths that no longer contribute instructions.
 */
export function renderInstructionRefresh(
  changed: readonly InstructionSource[],
  removed: readonly string[],
): string {
  const head =
    changed.length === 0
      ? "Instruction files were re-read after the conversation was compacted."
      : `Instruction files were re-read after the conversation was compacted; these differ from their earlier copies — each replaces its earlier copy:\n\n${changed
          .map((source) => `Contents of ${source.path}:\n\n${source.text.trim()}`)
          .join("\n\n")}`;
  return [head, ...removed.map((path) => `Instructions no longer present: ${path}`)].join(
    "\n\n",
  );
}

/**
 * Stops at the first regular file, checking candidate names in order within each directory.
 * @param cwd - Directory where the upward walk starts.
 * @param projectRoot - Inclusive stopping directory when encountered.
 * @param candidates - Filenames in order of preference.
 */
async function findNearestInstruction(
  cwd: string,
  projectRoot: string | undefined,
  candidates: readonly string[],
): Promise<string | undefined> {
  let current = resolve(cwd);
  const stop = projectRoot ? resolve(projectRoot) : undefined;
  while (true) {
    for (const name of candidates) {
      const path = join(current, name);
      if (await isRegularFile(path)) return path;
    }
    if (current === stop || current === dirname(current)) return undefined;
    current = dirname(current);
  }
}

/**
 * Reads a regular file and records the original size alongside the bounded text. Missing files are skipped.
 * @param path - Candidate instruction file.
 * @param scope - Origin label used in the announcement.
 * @param budgetBytes - Maximum bytes of UTF-8 text to include.
 */
async function readInstruction(
  path: string,
  scope: InstructionSource["scope"],
  budgetBytes: number,
): Promise<InstructionSource | undefined> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return undefined;
    const bytes = await readFile(path);
    const text = decodeUtf8Prefix(bytes, budgetBytes);
    return {
      path,
      scope,
      text,
      bytesRead: Buffer.byteLength(text),
      sizeBytes: info.size,
      truncated: info.size > Buffer.byteLength(text),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Backs up to a character boundary when the budget splits a UTF-8 sequence.
 * @param bytes - File contents.
 * @param maxBytes - Maximum prefix length in bytes.
 */
function decodeUtf8Prefix(bytes: Buffer, maxBytes: number): string {
  if (bytes.length <= maxBytes) return bytes.toString("utf8");
  let end = Math.max(0, maxBytes);
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
