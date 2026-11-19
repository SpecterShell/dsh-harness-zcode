/** Locates workspace memory and bounds the index included in a model request. */

import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import type { MemoryIndexRead } from "./types.ts";

export const MEMORY_INDEX_FILE = "MEMORY.md";
export const MEMORY_INDEX_BUDGET_BYTES = 64 * 1024;

export interface MemoryResolverFs {
  resolve(path: string, options?: { cwd?: string; signal?: AbortSignal }): Promise<unknown>;
  contains(parent: unknown, child: unknown): boolean;
}

export interface ProjectMemoryLocation {
  readonly workspaceRoot: string;
  readonly memoryRoot: string;
  readonly workspaceTarget: unknown;
  readonly memoryRootTarget: unknown;
  readonly indexPath: string;
  readonly indexTarget: unknown;
  /**
   * Checks each resolved file against the workspace boundary, including files reached through links.
   * @param name - File to resolve under the memory directory.
   * @param fileSignal - Cancellation override for this lookup.
   */
  resolveFile(name: string, signal?: AbortSignal): Promise<{ path: string; target: unknown }>;
}

/**
 * Resolves the memory directory and index through the host filesystem so containment accounts for links.
 * @param fs - Filesystem that resolves and compares sandbox targets.
 * @param workspaceRoot - Sandbox workspace shared by sessions started in different subdirectories.
 * @param configuredRoot - Workspace-relative memory directory.
 * @param signal - Cancellation for path resolution.
 */
export async function resolveProjectMemory(
  fs: MemoryResolverFs,
  workspaceRoot: string,
  configuredRoot: string,
  signal?: AbortSignal,
): Promise<ProjectMemoryLocation> {
  if (!configuredRoot.trim() || isAbsolute(configuredRoot)) {
    throw new Error("Memory root must be a non-empty project-relative path");
  }
  const root = resolve(workspaceRoot);
  const memoryRoot = resolve(root, configuredRoot);
  const options = signal ? { signal } : undefined;
  const workspaceTarget = await fs.resolve(root, options);
  const memoryRootTarget = await fs.resolve(memoryRoot, options);
  if (!fs.contains(workspaceTarget, memoryRootTarget)) {
    throw new Error("Memory files must remain inside the project working directory (sandbox workspace root)");
  }
  const resolveFile = async (
    name: string,
    fileSignal: AbortSignal | undefined = signal,
  ): Promise<{ path: string; target: unknown }> => {
    const path = resolve(memoryRoot, name);
    const target = await fs.resolve(path, fileSignal ? { signal: fileSignal } : undefined);
    if (!fs.contains(workspaceTarget, target)) {
      throw new Error("Memory files must remain inside the project working directory (sandbox workspace root)");
    }
    return { path, target };
  };
  const index = await resolveFile(MEMORY_INDEX_FILE);
  return {
    workspaceRoot: root,
    memoryRoot,
    workspaceTarget,
    memoryRootTarget,
    indexPath: index.path,
    indexTarget: index.target,
    resolveFile,
  };
}

/**
 * Reads the bounded UTF-8 prefix of MEMORY.md. A missing index produces an empty result.
 * @param input - Memory directory and optional byte budget.
 */
export async function readMemoryIndex(input: {
  readonly root: string;
  readonly budgetBytes?: number;
}): Promise<MemoryIndexRead> {
  const budget = input.budgetBytes ?? MEMORY_INDEX_BUDGET_BYTES;
  try {
    const bytes = await readFile(join(input.root, MEMORY_INDEX_FILE));
    const text = decodeUtf8Prefix(bytes, budget);
    return { text, truncated: Buffer.byteLength(text) < bytes.length };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { text: "", truncated: false };
    }
    throw error;
  }
}

/**
 * Limits extraction to interactive turns.
 * @param input - Execution mode and origin of the extraction request.
 */
export function shouldExtractMemory(input: {
  readonly mode: "interactive" | "headless";
  readonly source: "turn" | "prompt" | "target";
}): boolean {
  return input.mode === "interactive" && input.source === "turn";
}

/**
 * Formats a nonblank index as a system reminder and flags truncated content.
 * @param root - Memory directory displayed to the model.
 * @param index - Bounded index contents and truncation status.
 */
export function renderMemoryIndex(root: string, index: MemoryIndexRead): string {
  if (!index.text.trim()) return "";
  return [
    `<system-reminder>`,
    `Project memory index for ${root}:`,
    "",
    index.text.trim(),
    index.truncated ? "\n[Memory index truncated to the configured byte budget.]" : "",
    `</system-reminder>`,
  ].join("\n");
}

/**
 * Trims an incomplete trailing UTF-8 sequence at the byte limit.
 * @param bytes - Raw index contents.
 * @param maxBytes - Maximum prefix length in bytes.
 */
function decodeUtf8Prefix(bytes: Buffer, maxBytes: number): string {
  if (bytes.length <= maxBytes) return bytes.toString("utf8");
  let end = Math.max(0, maxBytes);
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}
