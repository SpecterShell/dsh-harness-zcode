/** Builds a one-request projection of older tool results while preserving session history. */

export const MICROCOMPACT_ENABLED_BY_DEFAULT = false;
export const MICROCOMPACT_KEEP_RECENT_TOOL_RESULTS = 5;
export const MICROCOMPACT_MIN_TOKEN_SAVINGS = 256;
export const MICROCOMPACT_CLEARED_TEXT = "[Older tool result removed by microcompaction.]";

export interface MicrocompactEntry {
  readonly kind: "tool-result" | "message";
  readonly text: string;
  readonly compactable?: boolean;
}

export interface MicrocompactResult {
  readonly entries: readonly MicrocompactEntry[];
  readonly applied: boolean;
  readonly clearedMessageCount: number;
  readonly preTokens: number;
  readonly postTokens: number;
  readonly tokensSaved: number;
}

/**
 * Replaces older eligible tool results only if estimated savings meet the configured floor.
 * @param entries - Conversation entries in chronological order.
 * @param options - Enable flag, token thresholds, estimator and number of recent eligible results to preserve.
 */
export function microcompact(
  entries: readonly MicrocompactEntry[],
  options: {
    readonly enabled?: boolean;
    readonly thresholdTokens: number;
    readonly keepRecentToolResults?: number;
    readonly minTokenSavings?: number;
    readonly estimateTokens?: (text: string) => number;
  },
): MicrocompactResult {
  const estimate = options.estimateTokens ?? ((text: string) => Math.ceil(text.length / 4));
  const preTokens = entries.reduce((sum, entry) => sum + estimate(entry.text), 0);
  const disabled = options.enabled !== true || preTokens < options.thresholdTokens;
  if (disabled) return unchanged(entries, preTokens);

  const keep = options.keepRecentToolResults ?? MICROCOMPACT_KEEP_RECENT_TOOL_RESULTS;
  const compactableIndexes = entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.kind === "tool-result" && entry.compactable !== false)
    .map(({ index }) => index);
  const clear = new Set(compactableIndexes.slice(0, Math.max(0, compactableIndexes.length - keep)));
  const projected = entries.map((entry, index) =>
    clear.has(index)
      ? { ...entry, text: "[Older tool result removed by microcompaction.]" }
      : entry,
  );
  const postTokens = projected.reduce((sum, entry) => sum + estimate(entry.text), 0);
  const tokensSaved = preTokens - postTokens;
  if (tokensSaved < (options.minTokenSavings ?? MICROCOMPACT_MIN_TOKEN_SAVINGS)) {
    return unchanged(entries, preTokens);
  }
  return {
    entries: projected,
    applied: clear.size > 0,
    clearedMessageCount: clear.size,
    preTokens,
    postTokens,
    tokensSaved,
  };
}

interface RuntimeAgent {
  readonly session: {
    readonly id: string;
    readonly seq?: number;
    deriveMessages(): unknown[];
    eventAt?(seq: number): { type?: string; data?: Record<string, unknown> } | undefined;
  };
}

interface RuntimeContext {
  root?: Pick<RuntimeContext, "on">;
  provide(name: "microcompaction", service: unknown): void;
  on(
    event: "llm/stream",
    listener: (
      options: Record<string, unknown> & { sessionId?: string; messages?: unknown[] },
      next: () => AsyncIterable<Record<string, unknown>>,
    ) => AsyncIterable<Record<string, unknown>>,
  ): void;
}

export interface RuntimeMicrocompactionSettings {
  readonly enabled: boolean;
  readonly threshold: number;
}

/**
 * Registers host-triggered microcompaction and consumes each pending projection on the next stream for that session.
 * @param ctx - Service registry and stream hook provider.
 * @param config - Supplies current enablement and context-window threshold on each call.
 */
export function applyMicrocompaction(
  ctx: RuntimeContext,
  config: { settings: () => RuntimeMicrocompactionSettings },
): void {
  const pending = new Map<string, unknown[]>();
  const service = {
    /**
     * Stages a projection if context pressure and estimated savings both qualify.
     * @param agent - Session that will issue the projected request.
     * @param input - Estimated context size in tokens and optional window size.
     */
    compactIfNeeded(
      agent: RuntimeAgent,
      input: { estimatedTokens: number; contextWindow?: number },
    ) {
      const settings = config.settings();
      const contextWindow = input.contextWindow ?? requestContextWindow(agent);
      if (
        !settings.enabled ||
        !contextWindow ||
        input.estimatedTokens < contextWindow * settings.threshold
      ) {
        return { applied: false, cleared: 0, tokensSaved: 0 };
      }
      const messages = agent.session.deriveMessages();
      const entries = messages.map((message) => messageEntry(message));
      const result = microcompact(entries, {
        enabled: true,
        thresholdTokens: 0,
      });
      if (!result.applied) return { applied: false, cleared: 0, tokensSaved: 0 };
      pending.set(
        agent.session.id,
        messages.map((message, index) =>
          result.entries[index]?.text === entries[index]?.text
            ? message
            : replaceMessageText(message, result.entries[index]?.text ?? ""),
        ),
      );
      return {
        applied: true,
        cleared: result.clearedMessageCount,
        tokensSaved: result.tokensSaved,
      };
    },
  };
  ctx.provide("microcompaction", service);
  (ctx.root ?? ctx).on("llm/stream", (options, next) => {
    const projection = options.sessionId ? pending.get(options.sessionId) : undefined;
    if (!projection) return next();
    pending.delete(options.sessionId!);
    return (async function* () {
      const original = options.messages;
      options.messages = projection;
      try {
        yield* next();
      } finally {
        if (original) options.messages = original;
        else delete options.messages;
      }
    })();
  });
}

/**
 * Joins text blocks for estimation and marks tool-role messages as eligible.
 * @param value - Runtime message from the derived session history.
 */
function messageEntry(value: unknown): MicrocompactEntry {
  const message = value as {
    role?: string;
    content?: Array<{ type?: string; text?: string }>;
  };
  const text = message.content
    ?.filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n") ?? "";
  return {
    kind: message.role === "tool" ? "tool-result" : "message",
    text,
    compactable: message.role === "tool",
  };
}

/**
 * Copies the message and replaces only its first text block. Later blocks retain their original contents.
 * @param value - Message selected for the projection.
 * @param text - Placeholder to send in place of the first text block.
 */
function replaceMessageText(value: unknown, text: string): unknown {
  const message = value as Record<string, unknown> & {
    content?: Array<Record<string, unknown> & { type?: string }>;
  };
  let replaced = false;
  const content = (message.content ?? []).map((block) => {
    if (replaced || block.type !== "text") return block;
    replaced = true;
    return { ...block, text };
  });
  return { ...message, content };
}

/**
 * Reads the window reported by the most recent request/context event.
 * @param agent - Session whose context window is needed.
 */
function requestContextWindow(agent: RuntimeAgent): number | undefined {
  if (!agent.session.eventAt || agent.session.seq === undefined) return undefined;
  for (let seq = agent.session.seq - 1; seq >= 0; seq -= 1) {
    const event = agent.session.eventAt(seq);
    if (event?.type !== "request/context") continue;
    const value = event.data?.contextWindow;
    return typeof value === "number" ? value : undefined;
  }
  return undefined;
}

/**
 * Reports an unapplied projection with zero savings and the original entries.
 * @param entries - Input conversation in chronological order.
 * @param tokens - Estimated input token count.
 */
function unchanged(
  entries: readonly MicrocompactEntry[],
  tokens: number,
): MicrocompactResult {
  return {
    entries,
    applied: false,
    clearedMessageCount: 0,
    preTokens: tokens,
    postTokens: tokens,
    tokensSaved: 0,
  };
}
