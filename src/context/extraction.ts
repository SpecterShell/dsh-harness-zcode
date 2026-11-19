/**
 * Durable project-memory extraction from completed agent turns.
 *
 * The lifecycle hook skips failed turns and disabled modes, asks the active model for
 * bounded one-line facts, and writes sanitized additions through sandbox policy and
 * filesystem write-intent hooks.
 */

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type { ZcodeContextSettings, ZcodeSettingsService } from "../config.ts";
import { resolveProjectMemory } from "./memory.ts";

export const MEMORY_EXTRACTION_MAX_MESSAGES = 12;
export const MEMORY_EXTRACTION_MAX_TOKENS = 512;
export const MEMORY_EXTRACTION_MAX_ENTRIES = 10;
export const MEMORY_EXTRACTION_MAX_ENTRY_CHARS = 200;
export const MEMORY_EXTRACTION_FACTS_FILE = "FACTS.md";
export const MEMORY_EXTRACTION_INDEX_ENTRY =
  "- [Extracted project memory](FACTS.md) — durable facts learned from prior interactive sessions";

const EXTRACTION_PROMPT = [
  "Extract durable project-memory facts from the conversation above.",
  "Return only new one-line Markdown bullets.",
  "Keep only stable user preferences, project decisions, constraints, and facts useful in later sessions.",
  "Do not repeat a fact already present in the supplied facts file.",
  "Do not include explanations, headings, code fences, or memory-file contents.",
  "If nothing is worth saving, return exactly: Nothing to save.",
].join("\n");

interface SessionLike {
  readonly id: string;
  requestHeader(): { config: { provider: string; model: string } } | undefined;
  deriveMessages(): unknown[];
}

interface AgentLike {
  readonly session: SessionLike;
  readonly options: { provider?: string; model?: string };
}

interface SandboxExecutionPolicy {
  readonly mode: "read-only" | "workspace-write" | "danger-full-access";
  readonly workspaceRoot: string;
  readonly additionalWritableRoots?: readonly string[];
  readonly sessionId?: any;
}

interface ExtractionContext {
  root?: Pick<ExtractionContext, "on">;
  fs: {
    resolve(path: string, options?: { cwd?: string; signal?: AbortSignal }): Promise<unknown>;
    contains(parent: unknown, child: unknown): boolean;
    processPath(target: unknown): string;
    stat(target: unknown, signal?: AbortSignal): Promise<{ type: string; version?: unknown } | undefined>;
    readText(target: unknown, signal?: AbortSignal): Promise<string>;
    writeText(
      target: unknown,
      content: string,
      expected: unknown,
      signal: AbortSignal,
      sandboxPolicy: SandboxExecutionPolicy,
    ): Promise<unknown>;
  };
  llm: {
    stream(options: {
      provider: string;
      model: string;
      messages: unknown[];
      maxTokens: number;
      signal: AbortSignal;
      sessionId: string;
      purpose: string;
    }): AsyncIterable<Record<string, unknown>>;
  };
  logger?: { warn(message: string): void };
  get(name: "zcodeSettings" | "sandboxPolicy"): ZcodeSettingsService | {
    resolve(request: { session: SessionLike }): SandboxExecutionPolicy;
  } | undefined;
  waterfall(
    event: "fs/write-intent",
    target: unknown,
    actor: object,
    next: () => undefined,
  ): Promise<unknown>;
  on(
    event: "agent/created",
    listener: (payload: { agent: AgentLike; signal?: AbortSignal }) => Promise<undefined>,
  ): void;
  on(
    event: "agent/error",
    listener: (payload: { agent: AgentLike; turn: number }) => void,
  ): void;
  on(
    event: "agent/turn-stopping",
    listener: (payload: { agent: AgentLike; turn: number; signal: AbortSignal }) => Promise<void>,
  ): void;
}

export interface MemoryExtractionConfig {
  readonly settings?: () => ZcodeContextSettings;
}

/**
 * Registers failed-turn tracking and best-effort extraction at turn shutdown.
 *
 * Abort signals still propagate, while model, policy, and filesystem failures are logged
 * so background maintenance cannot fail the user turn.
 *
 * @param ctx - Host lifecycle, model, filesystem, and policy services.
 * @param config - Optional dynamic context settings.
 */
export function applyMemoryExtraction(
  ctx: ExtractionContext,
  config: MemoryExtractionConfig = {},
): void {
  const failedTurns = new WeakMap<AgentLike, Set<number>>();
  const events = ctx.root ?? ctx;

  events.on("agent/error", ({ agent, turn }) => {
    let turns = failedTurns.get(agent);
    if (!turns) {
      turns = new Set();
      failedTurns.set(agent, turns);
    }
    turns.add(turn);
  });

  events.on("agent/turn-stopping", async ({ agent, turn, signal }) => {
    const turns = failedTurns.get(agent);
    if (turns?.delete(turn)) return;
    const settings = config.settings?.() ?? settingsFrom(ctx);
    if (
      settings.headless ||
      !settings.memoryEnabled ||
      !settings.memoryExtractionEnabled
    ) {
      return;
    }

    try {
      await extractTurnMemory(ctx, agent, settings, signal);
    } catch (error) {
      signal.throwIfAborted();
      // Extraction is maintenance. A model or policy failure must not fail the user turn.
      ctx.logger?.warn(`memory extraction failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

/**
 * Extracts and persists durable facts for one completed turn.
 *
 * The session sandbox policy determines the workspace root and authorizes both writes.
 * Existing targets must be regular files, and each write passes through `fs/write-intent`
 * before the filesystem service enforces the resolved policy.
 *
 * @param ctx - Host services used for extraction and persistence.
 * @param agent - Agent whose session supplies messages and model routing.
 * @param settings - Effective context and memory settings.
 * @param signal - Cancellation signal.
 * @returns `"written"` when memory changed, otherwise `"no-op"`.
 */
export async function extractTurnMemory(
  ctx: ExtractionContext,
  agent: AgentLike,
  settings: ZcodeContextSettings,
  signal: AbortSignal,
): Promise<"written" | "no-op"> {
  signal.throwIfAborted();
  const route = routeOf(agent);
  if (!route) return "no-op";
  const policyService = ctx.get("sandboxPolicy") as
    | { resolve(request: { session: SessionLike }): SandboxExecutionPolicy }
    | undefined;
  if (!policyService) throw new Error("Memory extraction requires sandbox policy enforcement");
  const policy = policyService.resolve({ session: agent.session });
  const memory = await resolveProjectMemory(
    ctx.fs,
    policy.workspaceRoot,
    settings.workspaceMemoryRoot,
    signal,
  );
  const { path: factsPath, target: factsTarget } = await memory.resolveFile(
    MEMORY_EXTRACTION_FACTS_FILE,
    signal,
  );
  const indexPath = memory.indexPath;
  const target = memory.indexTarget;
  const [indexInfo, factsInfo] = await Promise.all([
    ctx.fs.stat(target, signal),
    ctx.fs.stat(factsTarget, signal),
  ]);
  if (indexInfo && indexInfo.type !== "file") throw new Error(`Memory index is not a file: ${indexPath}`);
  if (factsInfo && factsInfo.type !== "file") throw new Error(`Memory facts target is not a file: ${factsPath}`);
  const [existingIndex, existingFacts] = await Promise.all([
    indexInfo ? ctx.fs.readText(target, signal) : "",
    factsInfo ? ctx.fs.readText(factsTarget, signal) : "",
  ]);
  const messages = limitedMessages(agent.session.deriveMessages());
  if (!messages.length) return "no-op";
  const extracted = await requestEntries(ctx, agent, route, messages, existingFacts, signal);
  const mergedFacts = mergeMemoryFacts(existingFacts, extracted);
  if (mergedFacts === normalizeIndex(existingFacts)) return "no-op";
  const mergedIndex = ensureMemoryIndexEntry(existingIndex);

  await mkdir(dirname(ctx.fs.processPath(factsTarget)), { recursive: true });
  const factsIntent = await ctx.waterfall("fs/write-intent", factsTarget, agent, () => undefined);
  await ctx.fs.writeText(
    factsTarget,
    mergedFacts,
    factsIntent,
    signal,
    policy,
  );
  if (mergedIndex !== normalizeIndex(existingIndex)) {
    const indexIntent = await ctx.waterfall("fs/write-intent", target, agent, () => undefined);
    await ctx.fs.writeText(target, mergedIndex, indexIntent, signal, policy);
  }
  return "written";
}

/**
 * Merges sanitized, deduplicated model output into the facts file.
 *
 * @param existing - Current facts file contents.
 * @param extracted - Raw model response.
 * @returns Normalized facts text capped at the per-turn entry limit.
 */
export function mergeMemoryFacts(existing: string, extracted: string): string {
  const current = normalizeIndex(existing);
  const seen = new Set(
    current.split("\n").map(normalizeEntryKey).filter(Boolean),
  );
  const additions: string[] = [];
  for (const line of extracted.split(/\r?\n/u)) {
    const entry = sanitizeEntry(line);
    if (!entry) continue;
    const key = normalizeEntryKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    additions.push(entry);
    if (additions.length >= MEMORY_EXTRACTION_MAX_ENTRIES) break;
  }
  if (!additions.length) return current;
  return `${current}${additions.join("\n")}\n`;
}

/**
 * Adds the extracted-facts link to the memory index once.
 *
 * @param existing - Current memory index contents.
 * @returns Normalized index text containing the extraction entry.
 */
export function ensureMemoryIndexEntry(existing: string): string {
  const current = normalizeIndex(existing);
  const key = normalizeEntryKey(MEMORY_EXTRACTION_INDEX_ENTRY);
  if (current.split("\n").some((line) => normalizeEntryKey(line) === key)) return current;
  return `${current}${MEMORY_EXTRACTION_INDEX_ENTRY}\n`;
}

/**
 * Reads context settings or returns the plugin defaults.
 *
 * @param ctx - Context that may provide the settings service.
 * @returns Effective context settings.
 */
function settingsFrom(ctx: ExtractionContext): ZcodeContextSettings {
  const service = ctx.get("zcodeSettings") as ZcodeSettingsService | undefined;
  return service?.context() ?? {
    headless: false,
    memoryEnabled: true,
    memoryExtractionEnabled: true,
    compactionEnabled: true,
    microcompactionEnabled: false,
    compactionThreshold: 0.9,
    microcompactionThreshold: 0.7,
    memoryMaxBytes: 32 * 1024,
    workspaceMemoryRoot: ".zcode/memory",
  };
}

/**
 * Resolves the extraction model from recorded request routing before agent defaults.
 *
 * @param agent - Agent providing request and fallback route settings.
 * @returns A complete provider/model route, or `undefined`.
 */
function routeOf(agent: AgentLike): { provider: string; model: string } | undefined {
  const logged = agent.session.requestHeader()?.config;
  const provider = logged?.provider ?? agent.options.provider;
  const model = logged?.model ?? agent.options.model;
  return provider && model ? { provider, model } : undefined;
}

/**
 * Keeps recent user and assistant text while dropping tool and non-text content.
 *
 * @param messages - Derived session messages.
 * @returns At most {@link MEMORY_EXTRACTION_MAX_MESSAGES} restricted messages.
 */
function limitedMessages(messages: unknown[]): unknown[] {
  const restricted: unknown[] = [];
  for (const value of messages) {
    const message = value as {
      role?: string;
      content?: Array<{ type?: string; text?: string }>;
      source?: unknown;
    };
    if (message.role !== "user" && message.role !== "assistant") continue;
    const content = message.content
      ?.filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => ({ type: "text", text: block.text }));
    if (content?.length) {
      restricted.push({
        role: message.role,
        content,
        ...(message.role === "assistant" && message.source ? { source: message.source } : {}),
      });
    }
  }
  return restricted.slice(-MEMORY_EXTRACTION_MAX_MESSAGES);
}

/**
 * Streams candidate facts from the active model with existing facts included for
 * deduplication, then rejects error and aborted finishes.
 *
 * @param ctx - Host LLM service.
 * @param agent - Agent supplying session identity.
 * @param route - Provider and model used for extraction.
 * @param messages - Restricted recent conversation.
 * @param existingFacts - Current facts supplied to the extraction prompt.
 * @param signal - Cancellation signal.
 * @returns Concatenated model text in block order.
 */
async function requestEntries(
  ctx: ExtractionContext,
  agent: AgentLike,
  route: { provider: string; model: string },
  messages: unknown[],
  existingFacts: string,
  signal: AbortSignal,
): Promise<string> {
  const text = new Map<number, string>();
  let finish: { kind?: string; failure?: { message?: string } } | undefined;
  const facts = normalizeIndex(existingFacts);
  for await (const chunk of ctx.llm.stream({
    ...route,
    messages: [
      ...messages,
      {
        role: "user",
        content: [{
          type: "text",
          text: `${EXTRACTION_PROMPT}\n\nExisting facts:\n${facts || "(empty)"}`,
        }],
      },
    ],
    maxTokens: MEMORY_EXTRACTION_MAX_TOKENS,
    signal,
    sessionId: agent.session.id,
    purpose: "memory-extraction",
  })) {
    if (chunk.type === "text-delta") {
      const index = Number(chunk.index);
      text.set(index, (text.get(index) ?? "") + String(chunk.text ?? ""));
    } else if (chunk.type === "block-end") {
      const block = chunk.block as { type?: string; text?: string } | undefined;
      if (block?.type === "text") text.set(Number(chunk.index), block.text ?? "");
    } else if (chunk.type === "finish") {
      finish = chunk.reason as typeof finish;
    }
  }
  signal.throwIfAborted();
  if (!finish || finish.kind === "error" || finish.kind === "aborted") {
    throw new Error(finish?.failure?.message ?? "Memory extraction failed");
  }
  return [...text.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, value]) => value)
    .join("\n")
    .trim();
}

/**
 * Normalizes line endings and ensures non-empty files end with one newline.
 *
 * @param value - File text to normalize.
 * @returns Normalized text.
 */
function normalizeIndex(value: string): string {
  const trimmed = value.replace(/\r\n/gu, "\n").trimEnd();
  return trimmed ? `${trimmed}\n` : "";
}

/**
 * Accepts only bounded single-line Markdown bullets from model output.
 *
 * @param line - Candidate output line.
 * @returns The trimmed entry, or `undefined` when invalid.
 */
function sanitizeEntry(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("- ") || trimmed.length > MEMORY_EXTRACTION_MAX_ENTRY_CHARS) {
    return undefined;
  }
  if (trimmed === "- " || /[\r\n]/u.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * Produces a case-insensitive, whitespace-normalized deduplication key.
 *
 * @param line - Memory entry to normalize.
 * @returns Stable comparison key.
 */
function normalizeEntryKey(line: string): string {
  return line.trim().replace(/\s+/gu, " ").toLocaleLowerCase();
}
