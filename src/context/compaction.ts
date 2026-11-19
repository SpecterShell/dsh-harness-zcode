/**
 * Full conversation compaction for ZCode sessions.
 *
 * The engine summarizes a selected surface range, rebuilds bounded file context through
 * the normal Read authorization path, and appends the checkpoint only after preflight
 * succeeds. It also exposes manual compaction and runs best-effort pressure compaction
 * before agent steps.
 */

import { randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";
import { scopeTarget } from "@deepseek-ai/dsh-scope";

import {
  READ_LIMIT,
  isZCodeReadDefinition,
  readZCodeFileSnapshot,
  zcodeFileTouches,
} from "../tools/index.ts";
import { clearPromptSnapshot } from "./snapshots.ts";
import {
  RESTORE_MAX_FILE_TOKENS,
  RESTORE_MAX_FILES,
  RESTORE_MAX_TOTAL_TOKENS,
  buildRestoreEntries,
  selectRestoreCandidates,
} from "./restore.ts";
import type { RestoreRead, RestoreStateEntry } from "./types.ts";

export const compactionName = "zcode-compaction";
export const FULL_COMPACT_RATIO = 0.9;
export const COMPACT_SUMMARY_MAX_TOKENS = 20_000;

const COMPACT_PROMPT = [
  "Summarize the conversation so work can continue in a fresh context.",
  "Preserve goals, decisions, constraints, unresolved work, errors, and concrete file state.",
  "Distinguish completed work from planned work. Keep exact paths and identifiers when relevant.",
  "Return only the summary.",
].join("\n");

type SurfaceOperation = "append" | { op: "replace"; startSeq: number; endSeq: number };

interface SessionLike {
  readonly id: string;
  readonly seq: number;
  readonly surface: { readonly nodes: readonly number[] };
  eventAt(seq: number): { type: string; data: Record<string, unknown> } | undefined;
  requestHeader(): { config: { provider: string; model: string } } | undefined;
  deriveMessages(): unknown[];
  deriveEventMessage?(event: unknown): unknown;
  append(inputs: readonly unknown[]): Array<{ seq: number }>;
}

interface AgentLike {
  readonly session: SessionLike;
  readonly options: { provider?: string; model?: string };
  runMaintenance?<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>;
}

interface FsLike {
  resolve(path: string, options?: { cwd?: string; signal?: AbortSignal }): Promise<unknown>;
  processPath(target: unknown): string;
  stat(target: unknown, signal?: AbortSignal): Promise<{ type: string; size?: number } | undefined>;
  readText(target: unknown, signal?: AbortSignal): Promise<string>;
}

interface CompactionContext {
  root: {
    get(name: string): unknown;
    provide(name: string, service: unknown): () => void;
    waterfall(
      carrier: object,
      event: "tools/pre-execute",
      exec: unknown,
      fallback: () => Promise<{ kind: "allow" }>,
    ): Promise<
      | { kind: "allow" }
      | { kind: "deny"; reason: string }
      | { kind: "cancel" }
      | { kind: "ask"; reason?: string }
    >;
  };
  fs: FsLike;
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
  tokenMeter?: {
    measure(session: SessionLike): {
      totalTokens: number;
      nodes: readonly { seq: number; heuristicTokens: number }[];
    };
  };
  sessions: { flush(session: SessionLike): Promise<boolean> };
  workingDirectory?: { ensure(agent: AgentLike, signal?: AbortSignal): Promise<string> };
  provide(name: "compaction", service: unknown): void;
  effect(callback: () => () => void, label?: string): void;
  on(
    event: "agent/pre-step",
    listener: (
      payload: { agent: AgentLike; signal: AbortSignal },
      next: () => Promise<unknown>,
    ) => Promise<unknown>,
  ): void;
}

export interface ZCodeCompactionSettings {
  readonly enabled: boolean;
  readonly threshold: number;
  readonly memoryRoot?: string;
}

export interface ZCodeCompactionConfig {
  readonly settings?: () => ZCodeCompactionSettings;
}

interface CompactionResult {
  compactionId: string;
  startSeq: number;
  summarySeq: number;
  endSeq: number;
  summary: Array<{ type: "text"; text: string }>;
  shadowedRange: { start: number; end: number };
  shadowedSeqs: number[];
  shadowedTokenCount: number;
  sourceCommandId?: string;
}

/**
 * Registers the compaction service and the pre-step pressure check.
 *
 * Automatic compaction failures are isolated from the user-visible model step.
 *
 * @param ctx - Host services and lifecycle hooks used by compaction.
 * @param config - Optional dynamic compaction settings.
 */
export function apply(ctx: CompactionContext, config: ZCodeCompactionConfig = {}): void {
  const engine = createEngine(ctx, config);
  ctx.provide("compaction", engine);
  ctx.on("agent/pre-step", async (payload, next) => {
    try {
      await engine.compactIfNeeded(payload.agent, "pressure", payload.signal);
    } catch {
      // Automatic compaction is best-effort. The proposed model step continues.
    }
    return next();
  });
}

/**
 * Creates the session-scoped compaction operations exposed to the host.
 *
 * @param ctx - Host services used to summarize, authorize reads, and commit events.
 * @param config - Source of current compaction settings.
 * @returns Automatic, manual, and explicit-range compaction operations.
 */
function createEngine(ctx: CompactionContext, config: ZCodeCompactionConfig) {
  const active = new WeakSet<SessionLike>();

  /**
   * Compacts when explicitly recovering from overflow or when measured pressure crosses
   * the configured fraction of the request context window.
   *
   * @param agent - Agent whose current session may be compacted.
   * @param trigger - Reason for evaluating compaction.
   * @param signal - Cancels the operation before commit.
   * @returns The committed compaction, or `null` when no compaction is needed.
   */
  async function compactIfNeeded(
    agent: AgentLike,
    trigger: "pressure" | "context-overflow",
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    const settings = resolveSettings(config);
    if (!settings.enabled) return null;
    if (trigger !== "context-overflow") {
      const pressure = ctx.tokenMeter?.measure(agent.session);
      const contextWindow = requestContextWindow(agent.session);
      if (
        !contextWindow ||
        !pressure ||
        pressure.totalTokens < contextWindow * settings.threshold
      ) {
        return null;
      }
    }
    return compactSelected(agent, signal);
  }

  /**
   * Runs user-requested compaction, joining the agent maintenance signal when available.
   *
   * @param agent - Agent whose current compactable range is selected.
   * @param signal - Caller cancellation signal.
   * @param sourceCommandId - Command identifier recorded on generated events.
   * @returns The committed compaction, or `null` when the surface has no compactable range.
   */
  async function compactNow(
    agent: AgentLike,
    signal: AbortSignal,
    sourceCommandId?: string,
  ): Promise<CompactionResult | null> {
    const run = (operationSignal: AbortSignal) =>
      compactSelected(agent, operationSignal, sourceCommandId);
    return agent.runMaintenance
      ? agent.runMaintenance((maintenanceSignal) =>
          run(AbortSignal.any([signal, maintenanceSignal])),
        )
      : run(signal);
  }

  /**
   * Compacts an explicit inclusive range on the current session surface.
   *
   * @param start - First surface sequence to replace.
   * @param end - Last surface sequence to replace.
   * @param agent - Agent that owns the session.
   * @param signal - Cancellation signal.
   * @returns The committed compaction metadata.
   */
  async function compactRegion(
    start: number,
    end: number,
    agent: AgentLike,
    signal = new AbortController().signal,
  ): Promise<CompactionResult> {
    return compactRange(agent, signal, start, end);
  }

  /**
   * Selects and compacts the mutable conversation range after leading system messages.
   *
   * @param agent - Agent that owns the current surface.
   * @param signal - Cancellation signal.
   * @param sourceCommandId - Optional command identifier for audit metadata.
   * @returns The committed compaction, or `null` when no mutable range exists.
   */
  async function compactSelected(
    agent: AgentLike,
    signal: AbortSignal,
    sourceCommandId?: string,
  ): Promise<CompactionResult | null> {
    const range = compactableRange(agent.session);
    if (!range) return null;
    return compactRange(agent, signal, range.start, range.end, sourceCommandId);
  }

  /**
   * Prepares and commits one compaction transaction.
   *
   * Summary generation, restore reads, and surface-stability checks complete before the
   * first append. A per-session guard rejects overlapping compactions. After append, the
   * durable session is flushed before restore state and prompt snapshots are replaced.
   *
   * @param agent - Agent that owns the session.
   * @param signal - Cancels pre-commit work.
   * @param start - First surface sequence to replace.
   * @param end - Last surface sequence to replace.
   * @param sourceCommandId - Optional command identifier recorded with the checkpoint.
   * @returns Metadata for the committed checkpoint and shadowed events.
   */
  async function compactRange(
    agent: AgentLike,
    signal: AbortSignal,
    start: number,
    end: number,
    sourceCommandId?: string,
  ): Promise<CompactionResult> {
    signal.throwIfAborted();
    const session = agent.session;
    if (active.has(session)) throw new Error("Compaction is already active for this session");
    active.add(session);
    try {
      const originalNodes = [...session.surface.nodes];
      const selected = selectedNodes(originalNodes, start, end);
      if (!selected.length) throw new Error("Compaction range is not on the current surface");
      const target = routeOf(agent);
      if (!target) throw new Error("Compaction requires a provider and model");

      // Build every replacement before the first append, so summary/read
      // failures leave both the surface and durable event stream untouched.
      const summary = await summarize(ctx, session, selected, target, signal);
      const workingDirectory =
        (await ctx.workingDirectory?.ensure(agent, signal)) ??
        resolve((session as { header?: { cwd?: string } }).header?.cwd ?? process.cwd());
      const preCommitPrices = new Map(
        ctx.tokenMeter?.measure(session).nodes.map((node) => [node.seq, node.heuristicTokens]) ??
          [],
      );
      const restore = await freshRestore(
        ctx,
        agent,
        workingDirectory,
        resolveSettings(config),
        signal,
      );
      if (!sameNodes(originalNodes, session.surface.nodes)) {
        throw new Error("Compaction input changed before commit");
      }

      const compactionId = randomUUID();
      const inputs: unknown[] = [
        [
          "compaction/start",
          { compactionId, ...(sourceCommandId ? { sourceCommandId } : {}) },
        ],
        userMessageInput(
          summary,
          {
            kind: "compact-checkpoint",
            compactionId,
            ...(sourceCommandId ? { sourceCommandId } : {}),
          },
          { op: "replace", startSeq: start, endSeq: end },
          selected,
        ),
        ...restore.entries.map((entry) =>
          userMessageInput(entry.text, { kind: "user" }, "append", selected),
        ),
        ["compaction/end", { compactionId, status: "completed" }],
      ];
      const appended = session.append(inputs);
      await ctx.sessions.flush(session);
      zcodeFileTouches.replace(agent as never, restore.state as never);
      clearPromptSnapshot(agent);

      const summaryEvent = appended[1];
      const endEvent = appended.at(-1);
      if (!summaryEvent || !endEvent) throw new Error("Compaction commit returned no events");
      return {
        compactionId,
        ...(sourceCommandId ? { sourceCommandId } : {}),
        startSeq: appended[0]?.seq ?? summaryEvent.seq,
        summarySeq: summaryEvent.seq,
        endSeq: endEvent.seq,
        summary: [{ type: "text", text: summary }],
        shadowedRange: { start, end },
        shadowedSeqs: selected,
        shadowedTokenCount: selected.reduce(
          (total, seq) => total + (preCommitPrices.get(seq) ?? 0),
          0,
        ),
      };
    } finally {
      active.delete(session);
    }
  }

  return { compactIfNeeded, compactNow, compactRegion };
}

/**
 * Rebuilds bounded restore context from files touched by the agent.
 *
 * Instruction memory files are excluded, and every candidate is read through
 * {@link authorizedToolRead}; denied, oversized, or failed reads become denied entries.
 *
 * @param ctx - Host filesystem, tool policy, and restore services.
 * @param agent - Agent whose file-touch state supplies restore candidates.
 * @param workingDirectory - Base directory for relative touched paths.
 * @param settings - Current compaction settings.
 * @param signal - Cancellation signal.
 * @returns Restore entries and the state to install after commit.
 */
async function freshRestore(
  ctx: CompactionContext,
  agent: AgentLike,
  workingDirectory: string,
  settings: ZCodeCompactionSettings,
  signal: AbortSignal,
) {
  const state = new Map<string, RestoreStateEntry>();
  for (const [path, touch] of zcodeFileTouches.touches(agent as never)) {
    if (
      touch.sourceTool === "read" ||
      touch.sourceTool === "write" ||
      touch.sourceTool === "edit"
    ) {
      state.set(path, { ...touch, sourceTool: touch.sourceTool });
    }
  }
  const memoryRoot = settings.memoryRoot;
  const excludedPaths = [
    ...[...state.values()]
      .filter((entry) => basename(entry.path) === "AGENTS.md")
      .map((entry) => entry.path),
    ...(memoryRoot
      ? [
          resolve(workingDirectory, memoryRoot, "MEMORY.md"),
          ...[...state.values()]
            .filter((entry) =>
              entry.path
                .replaceAll("\\", "/")
                .endsWith(`/${memoryRoot.replaceAll("\\", "/").replace(/^\.?\//u, "")}/MEMORY.md`),
            )
            .map((entry) => entry.path),
        ]
      : []),
  ];
  const candidates = selectRestoreCandidates(state, {
    maxFiles: RESTORE_MAX_FILES,
    excludedPaths,
    workingDirectory,
  });
  const reads: RestoreRead[] = [];
  for (const candidate of candidates) {
    signal.throwIfAborted();
    try {
      const target = await ctx.fs.resolve(candidate.path, { cwd: workingDirectory, signal });
      const canonicalPath = ctx.fs.processPath(target);
      const requestedSpelling = candidate.requestedPath ?? candidate.path;
      const requestedPath = resolve(
        candidate.requestedCwd ?? workingDirectory,
        requestedSpelling,
      );
      const authorizedText = await authorizedToolRead(
        ctx,
        agent,
        canonicalPath,
        requestedSpelling,
        requestedPath,
        signal,
      );
      if (authorizedText === undefined) {
        reads.push({ type: "denied", path: candidate.path });
        continue;
      }
      reads.push({ type: "content", path: canonicalPath, text: authorizedText });
    } catch {
      signal.throwIfAborted();
      reads.push({ type: "denied", path: candidate.path });
    }
  }
  return buildRestoreEntries(candidates, reads, {
    maxFileTokens: RESTORE_MAX_FILE_TOKENS,
    maxTotalTokens: RESTORE_MAX_TOTAL_TOKENS,
  });
}

/**
 * Reads a restore candidate only after applying the normal Read tool policy.
 *
 * Policy gates and guards are checked for the requested spelling, resolved request path,
 * and canonical path so aliases cannot bypass authorization. Content is omitted when any
 * check denies access or when the file exceeds the Read line limit.
 *
 * @param ctx - Host context containing tool policy and filesystem access.
 * @param agent - Agent used as the authorization scope.
 * @param canonicalPath - Canonical path passed to the snapshot reader.
 * @param requestedSpelling - Path spelling originally used by the agent.
 * @param requestedPath - Absolute path resolved from the original request.
 * @param signal - Cancellation signal.
 * @returns Authorized file text, or `undefined` when access is unavailable.
 */
async function authorizedToolRead(
  ctx: CompactionContext,
  agent: AgentLike,
  canonicalPath: string,
  requestedSpelling: string,
  requestedPath: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  const tools = ctx.root.get("tools") as {
    executable(name: string, scope?: unknown): {
      readonly name: string;
      readonly parameters: unknown;
      execute(args: unknown, exec: unknown): Promise<unknown>;
    } | undefined;
    checkGuards(exec: unknown): unknown;
  } | undefined;
  const definition = tools?.executable("Read", agent);
  if (tools === undefined || definition === undefined || !isZCodeReadDefinition(definition)) {
    return undefined;
  }
  const paths = [...new Set([requestedSpelling, requestedPath, canonicalPath])];
  try {
    for (const policyPath of paths) {
      signal.throwIfAborted();
      const callId = randomUUID();
      const policyArgs = { file_path: policyPath };
      const exec = {
        callId,
        rootCallId: callId,
        name: "Read",
        schema: definition,
        arguments: policyArgs,
        agent,
        signal,
        token: Symbol("zcode-maintenance-read"),
        deferContext() {},
        concludeTurn() {},
      };
      const gate = await ctx.root.waterfall(
        scopeTarget(tools, agent),
        "tools/pre-execute",
        exec,
        () => Promise.resolve({ kind: "allow" as const }),
      );
      if (gate.kind !== "allow" || tools.checkGuards(exec) !== undefined) return undefined;
    }
    const snapshot = await readZCodeFileSnapshot(
      ctx as never,
      canonicalPath,
      requestedPath,
      signal,
    );
    if (snapshot.lines.length > READ_LIMIT) return undefined;
    return snapshot.text;
  } catch {
    signal.throwIfAborted();
    return undefined;
  }
}

/**
 * Streams a summary for the selected session events and rejects incomplete model finishes.
 *
 * @param ctx - Host LLM service.
 * @param session - Session containing the source events.
 * @param selected - Surface sequence numbers included in the summary.
 * @param target - Provider and model used for the maintenance request.
 * @param signal - Cancellation signal.
 * @returns Non-empty summary text.
 */
async function summarize(
  ctx: CompactionContext,
  session: SessionLike,
  selected: readonly number[],
  target: { provider: string; model: string },
  signal: AbortSignal,
): Promise<string> {
  const text = new Map<number, string>();
  let finish: { kind: string; failure?: { message?: string } } | undefined;
  for await (const chunk of ctx.llm.stream({
    ...target,
    messages: [
      ...messagesForSelection(session, selected),
      { role: "user", content: [{ type: "text", text: COMPACT_PROMPT }] },
    ],
    maxTokens: COMPACT_SUMMARY_MAX_TOKENS,
    signal,
    sessionId: session.id,
    purpose: "compaction",
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
  if (
    !finish ||
    finish.kind === "error" ||
    finish.kind === "aborted" ||
    finish.kind === "max-tokens"
  ) {
    throw new Error(finish?.failure?.message ?? "Compaction summary failed");
  }
  const summary = [...text.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, value]) => value)
    .join("\n")
    .trim();
  if (!summary) throw new Error("Compaction summary was empty");
  return summary;
}

/**
 * Derives messages for selected events, falling back to the full derived conversation
 * when event-level derivation is unavailable.
 *
 * @param session - Session that owns the events.
 * @param selected - Event sequence numbers to derive.
 * @returns Messages supplied to the summary request.
 */
function messagesForSelection(session: SessionLike, selected: readonly number[]): unknown[] {
  if (!session.deriveEventMessage) return session.deriveMessages();
  return selected.flatMap((seq) => {
    const event = session.eventAt(seq);
    if (!event) return [];
    const message = session.deriveEventMessage?.(event);
    return message ? [message] : [];
  });
}

/**
 * Builds a user-message event input with its surface replacement or append metadata.
 *
 * @param text - Message body.
 * @param source - Source metadata stored on the message.
 * @param surfaceOp - Surface operation performed by the event.
 * @param sourceEventSeqs - Events from which the message was derived.
 * @returns Input accepted by the session event appender.
 */
function userMessageInput(
  text: string,
  source: Record<string, unknown>,
  surfaceOp: SurfaceOperation,
  sourceEventSeqs: number[],
): unknown {
  return [
    "user/message",
    {
      id: randomUUID(),
      role: "user",
      content: [{ type: "text", text }],
      source,
    },
    { surfaceOp, sourceEventSeqs },
  ];
}

/**
 * Finds the inclusive range after leading system and developer messages.
 *
 * @param session - Session whose visible surface is inspected.
 * @returns The compactable range, or `undefined` for an empty immutable-only surface.
 */
function compactableRange(session: SessionLike): { start: number; end: number } | undefined {
  const nodes = session.surface.nodes;
  let startIndex = 0;
  while (startIndex < nodes.length) {
    const event = session.eventAt(nodes[startIndex]!);
    if (event?.type !== "system/message" && event?.type !== "developer/message") break;
    startIndex += 1;
  }
  if (startIndex >= nodes.length) return undefined;
  return { start: nodes[startIndex]!, end: nodes.at(-1)! };
}

/**
 * Extracts an inclusive range from the current ordered surface.
 *
 * @param nodes - Current surface sequence numbers.
 * @param start - First requested sequence.
 * @param end - Last requested sequence.
 * @returns Selected nodes, or an empty array for an invalid range.
 */
function selectedNodes(nodes: readonly number[], start: number, end: number): number[] {
  const startIndex = nodes.indexOf(start);
  const endIndex = nodes.indexOf(end);
  return startIndex < 0 || endIndex < startIndex ? [] : nodes.slice(startIndex, endIndex + 1);
}

/**
 * Tests whether the surface remained unchanged during preflight.
 *
 * @param left - Surface snapshot captured before asynchronous work.
 * @param right - Current surface sequence numbers.
 * @returns Whether both ordered sequences match.
 */
function sameNodes(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((seq, index) => seq === right[index]);
}

/**
 * Resolves the maintenance model route from the recorded request before agent defaults.
 *
 * @param agent - Agent providing request and fallback route settings.
 * @returns A complete provider/model pair, or `undefined`.
 */
function routeOf(agent: AgentLike): { provider: string; model: string } | undefined {
  const routed = agent.session.requestHeader()?.config;
  const provider = routed?.provider ?? agent.options.provider;
  const model = routed?.model ?? agent.options.model;
  return provider && model ? { provider, model } : undefined;
}

/**
 * Reads the most recent context-window value recorded in session events.
 *
 * @param session - Session whose request history is searched newest first.
 * @returns The recorded context window, or `undefined`.
 */
function requestContextWindow(session: SessionLike): number | undefined {
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(seq);
    if (event?.type !== "request/context") continue;
    const value = event.data.contextWindow;
    return typeof value === "number" ? value : undefined;
  }
  return undefined;
}

/**
 * Resolves current settings with full-compaction defaults.
 *
 * @param config - Optional settings provider.
 * @returns Effective compaction settings.
 */
function resolveSettings(config: ZCodeCompactionConfig): ZCodeCompactionSettings {
  return config.settings?.() ?? { enabled: true, threshold: FULL_COMPACT_RATIO };
}
