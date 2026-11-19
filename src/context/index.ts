/**
 * ZCode context plugin entry point.
 *
 * The plugin installs persona and behavior prompt sections, wires compaction and memory
 * maintenance, and mounts bounded workspace instructions and project memory before each
 * agent step. Mounted context is persisted in the prompt snapshot used for the request.
 */

import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";

import type { ZcodeSettingsService } from "../config.ts";
import { apply as applyCompaction } from "./compaction.ts";
import { applyMemoryExtraction } from "./extraction.ts";
import {
  DEFAULT_INSTRUCTION_CANDIDATES,
  INSTRUCTION_BUDGET_BYTES,
  renderInstructionAnnouncement,
} from "./instructions.ts";
import { renderMemoryIndex, resolveProjectMemory } from "./memory.ts";
import { applyMicrocompaction } from "./microcompaction.ts";
import { snapshotOf } from "./prompt.ts";
import { persistPromptSnapshot } from "./snapshots.ts";

export * from "./compaction.ts";
export * from "./extraction.ts";
export * from "./instructions.ts";
export * from "./memory.ts";
export * from "./microcompaction.ts";
export * from "./prompt.ts";
export * from "./restore.ts";
export * from "./snapshots.ts";
export * from "./types.ts";

export const name = "zcode-context";
export const inject = [
  "systemPrompt",
  "llm",
  "tokenMeter",
  "sessions",
  "fs",
  "workingDirectory",
  "sandboxPolicy",
];

const PERSONA = [
  "You are ZCode, an interactive agent.",
  "",
  "You are an agent working with the user toward their goals, using your own judgment along the way.",
  "",
  "IMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. Refuse requests for destructive techniques, DoS attacks, mass targeting, supply chain compromise, or detection evasion for malicious purposes. Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context: pentesting engagements, CTF competitions, security research, or defensive use cases.",
  "",
  "# Harness",
  " - Text you output outside of tool use is displayed to the user as Github-flavored markdown in a terminal.",
  " - Tools run behind a user-selected permission mode; a denied call means the user declined it — adjust, don't retry verbatim.",
  " - `<system-reminder>` tags in messages and tool results are injected by the harness, not the user. Hooks may intercept tool calls; treat hook output as user feedback.",
  " - Prefer the dedicated file/search tools over shell commands when one fits. Independent tool calls can run in parallel in one response.",
  " - Reference code as `file_path:line_number` — it's clickable.",
].join("\n");

const DYNAMIC_BEHAVIOR = [
  "Write code that reads like the surrounding code: match its comment density, naming, and idiom.",
  "For hard-to-reverse or outward-facing actions, confirm first unless durably authorized.",
  "Report outcomes faithfully, including failed or skipped verification.",
].join("\n\n");

interface HostFs {
  resolve(path: string, options?: { cwd?: string; signal?: AbortSignal }): Promise<unknown>;
  contains(parent: unknown, child: unknown): boolean;
  stat(target: unknown, signal?: AbortSignal): Promise<{ type: string; size?: number } | undefined>;
  readText(target: unknown, signal?: AbortSignal): Promise<string>;
}

interface ContextPlugin {
  fs: HostFs;
  workingDirectory: {
    ensure(agent: unknown, signal?: AbortSignal): Promise<string>;
  };
  systemPrompt: {
    getSectionOrder(name: "DEPLOYMENT_PERSONA_PREFIX"): number;
    section(section: {
      name: string;
      order: number;
      text: string;
      interpolate?: boolean;
      complete?: boolean;
    }): () => void;
    context(context: {
      name: string;
      order: number;
      text: string;
      interpolate?: boolean;
    }): () => void;
  };
  get(name: "zcodeSettings"): ZcodeSettingsService | undefined;
  get(name: "sandboxPolicy"): {
    resolve(request: { session: unknown }): { workspaceRoot: string };
  } | undefined;
  effect(callback: () => () => void, label?: string): void;
  provide(name: "compaction", service: unknown): void;
  on(
    event: "agent/pre-step",
    listener: (
      payload: {
        agent: unknown;
        signal: AbortSignal;
      },
      next: () => Promise<
        | { kind: "reject" }
        | {
            kind: "enter";
            messages: Array<{
              id: string;
              role: "user";
              content: Array<{ type: "text"; text: string }>;
              source: { kind: "user" };
            }>;
            startsRequestSeries?: true;
          }
      >,
    ) => Promise<unknown>,
  ): void;
}

export interface Config {
  readonly completePersona?: boolean;
}

/**
 * Installs prompt sections, maintenance services, and pre-step workspace context mounting.
 *
 * The pre-step hook resolves instructions from user and project locations, resolves memory
 * inside the sandbox policy's workspace root, snapshots the assembled prompt, and injects
 * only the persisted workspace-context section as a harness system reminder.
 *
 * @param ctx - Host plugin services and lifecycle hooks.
 * @param config - Persona configuration.
 */
export function apply(ctx: ContextPlugin, config: Config = {}): void {
  ctx.effect(
    () => {
      const section = {
        order: ctx.systemPrompt.getSectionOrder("DEPLOYMENT_PERSONA_PREFIX"),
        text: PERSONA,
        interpolate: false,
        ...(config.completePersona ? { complete: true as const } : {}),
      };
      return ctx.systemPrompt.section({ name: "zcode:persona", ...section });
    },
    "zcode.persona",
  );
  ctx.effect(
    () =>
      ctx.systemPrompt.context({
        name: "zcode:dynamic-behavior",
        order: 300,
        text: DYNAMIC_BEHAVIOR,
        interpolate: false,
      }),
    "zcode.dynamic-behavior",
  );

  applyCompaction(ctx as never, {
    settings: () => {
      const current = settings(ctx);
      return {
        enabled: current.compactionEnabled,
        threshold: current.compactionThreshold,
        memoryRoot: current.workspaceMemoryRoot,
      };
    },
  });
  applyMemoryExtraction(ctx as never, { settings: () => settings(ctx) });
  applyMicrocompaction(ctx as never, {
    settings: () => {
      const current = settings(ctx);
      return {
        enabled: current.microcompactionEnabled,
        threshold: current.microcompactionThreshold,
      };
    },
  });

  ctx.on("agent/pre-step", async (payload, next) => {
    const decision = await next();
    if (decision.kind !== "enter") return decision;
    const cwd = await ctx.workingDirectory.ensure(payload.agent, payload.signal);
    const current = settings(ctx);
    const instructionText = await mountedInstructionText(ctx.fs, cwd, payload.signal);
    const memoryText = current.memoryEnabled
      ? await mountedMemoryText(
          ctx.fs,
          workspaceRootFor(ctx, payload.agent),
          current.workspaceMemoryRoot,
          current.memoryMaxBytes,
          payload.signal,
        )
      : "";
    const text = [instructionText, memoryText].filter(Boolean).join("\n\n");
    const agent = payload.agent as {
      session?: {
        requestHeader?(): { config?: { provider?: string; model?: string } } | undefined;
      };
      options?: { provider?: string; model?: string };
    };
    const routed = agent.session?.requestHeader?.()?.config;
    const provider = routed?.provider ?? agent.options?.provider;
    const model = routed?.model ?? agent.options?.model;
    const snapshot = persistPromptSnapshot(
      payload.agent as object,
      snapshotOf(
        [
          { name: "zcode:persona", text: PERSONA, order: 100, cacheHint: "stable" },
          {
            name: "zcode:dynamic-behavior",
            text: DYNAMIC_BEHAVIOR,
            order: 300,
            cacheHint: "dynamic",
          },
          ...(text
            ? [{ name: "zcode:workspace-context", text, order: 400, cacheHint: "dynamic" as const }]
            : []),
        ],
        provider && model ? { provider, model } : undefined,
      ),
    );
    const persistedText = snapshot.sections.find(
      (section) => section.name === "zcode:workspace-context",
    )?.text ?? "";
    if (!persistedText) return decision;
    return {
      ...decision,
      messages: [
        ...decision.messages,
        {
          id: randomUUID(),
          role: "user",
          content: [{ type: "text", text: `<system-reminder>\n${persistedText}\n</system-reminder>` }],
          source: { kind: "user" },
        },
      ],
    };
  });
}

/**
 * Reads context settings or returns the plugin defaults.
 *
 * @param ctx - Context that may provide the settings service.
 * @returns Effective context settings.
 */
function settings(ctx: ContextPlugin) {
  return (
    ctx.get("zcodeSettings")?.context() ?? {
      headless: false,
      memoryEnabled: true,
      memoryExtractionEnabled: true,
      compactionEnabled: true,
      microcompactionEnabled: false,
      compactionThreshold: 0.9,
      microcompactionThreshold: 0.7,
      memoryMaxBytes: 32 * 1024,
      workspaceMemoryRoot: ".zcode/memory",
    }
  );
}

/**
 * Loads bounded user and nearest workspace instructions for the current directory.
 *
 * @param fs - Host filesystem abstraction.
 * @param cwd - Agent working directory.
 * @param signal - Cancellation signal.
 * @returns Rendered instruction announcement, or an empty string.
 */
async function mountedInstructionText(
  fs: HostFs,
  cwd: string,
  signal: AbortSignal,
): Promise<string> {
  const projectRoot = await findProjectRoot(fs, cwd, signal);
  const workspace = await findNearestInstruction(fs, cwd, projectRoot, signal);
  const sources = [];
  const home = process.env.HOME?.trim() || process.env.USERPROFILE?.trim();
  if (home) {
    const user = await readHostInstruction(
      fs,
      join(home, ".zcode", DEFAULT_INSTRUCTION_CANDIDATES[0]),
      "user",
      signal,
    );
    if (user) sources.push(user);
  }
  if (workspace) {
    const source = await readHostInstruction(fs, workspace, "workspace", signal);
    if (source && !sources.some((item) => item.path === source.path)) sources.push(source);
  }
  return sources.length ? renderInstructionAnnouncement(sources) : "";
}

/**
 * Loads and renders the project memory index within a byte budget.
 *
 * The configured memory root is resolved relative to the policy-derived workspace root by
 * {@link resolveProjectMemory}. Non-file indexes are ignored.
 *
 * @param fs - Host filesystem abstraction.
 * @param workspaceRoot - Sandbox policy workspace root.
 * @param configuredRoot - Configured project-memory directory.
 * @param budgetBytes - Maximum bytes mounted into the prompt.
 * @param signal - Cancellation signal.
 * @returns Rendered memory context, or an empty string.
 */
async function mountedMemoryText(
  fs: HostFs,
  workspaceRoot: string,
  configuredRoot: string,
  budgetBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const memory = await resolveProjectMemory(fs, workspaceRoot, configuredRoot, signal);
  const info = await fs.stat(memory.indexTarget, signal);
  if (!info || info.type !== "file") return "";
  const text = await fs.readText(memory.indexTarget, signal);
  if (text === undefined) return "";
  const bytes = Buffer.from(text);
  const bounded = bytes.subarray(0, budgetBytes).toString("utf8").replace(/\uFFFD$/u, "");
  return renderMemoryIndex(memory.memoryRoot, {
    text: bounded,
    truncated: Buffer.byteLength(bounded) < bytes.length,
  });
}

/**
 * Resolves the session workspace root through sandbox policy enforcement.
 *
 * @param ctx - Host context providing the sandbox policy service.
 * @param agent - Agent whose session selects the policy.
 * @returns Policy-authorized workspace root.
 * @throws When policy enforcement or session identity is unavailable.
 */
function workspaceRootFor(ctx: ContextPlugin, agent: unknown): string {
  const policy = ctx.get("sandboxPolicy");
  const session = (agent as { session?: unknown }).session;
  if (!policy || !session) throw new Error("Project memory requires sandbox policy enforcement");
  return policy.resolve({ session }).workspaceRoot;
}

/**
 * Walks upward to the nearest Git marker without crossing the filesystem root.
 *
 * @param fs - Host filesystem abstraction.
 * @param cwd - Starting directory.
 * @param signal - Cancellation signal.
 * @returns Project root, or the resolved starting directory when none is found.
 */
async function findProjectRoot(fs: HostFs, cwd: string, signal: AbortSignal): Promise<string> {
  let directory = resolve(cwd);
  while (true) {
    if (await hostExists(fs, join(directory, ".git"), signal)) return directory;
    const parent = dirname(directory);
    if (parent === directory) return resolve(cwd);
    directory = parent;
  }
}

/**
 * Finds the nearest instruction file between the working directory and project root.
 *
 * @param fs - Host filesystem abstraction.
 * @param cwd - Starting directory.
 * @param projectRoot - Highest directory included in the search.
 * @param signal - Cancellation signal.
 * @returns Instruction path, or `undefined`.
 */
async function findNearestInstruction(
  fs: HostFs,
  cwd: string,
  projectRoot: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  let directory = resolve(cwd);
  while (true) {
    const path = join(directory, DEFAULT_INSTRUCTION_CANDIDATES[0]);
    if (await hostExists(fs, path, signal, "file")) return path;
    if (directory === projectRoot || dirname(directory) === directory) return undefined;
    directory = dirname(directory);
  }
}

/**
 * Reads one instruction source and truncates it to the prompt byte budget.
 *
 * @param fs - Host filesystem abstraction.
 * @param path - Instruction file path.
 * @param scope - User or workspace source classification.
 * @param signal - Cancellation signal.
 * @returns Instruction source metadata, or `undefined` when unavailable.
 */
async function readHostInstruction(
  fs: HostFs,
  path: string,
  scope: "user" | "workspace",
  signal: AbortSignal,
) {
  const text = await readHostText(fs, path, signal);
  if (text === undefined) return undefined;
  const bytes = Buffer.from(text);
  const bounded = bytes
    .subarray(0, INSTRUCTION_BUDGET_BYTES)
    .toString("utf8")
    .replace(/\uFFFD$/u, "");
  return {
    path,
    scope,
    text: bounded,
    bytesRead: Buffer.byteLength(bounded),
    sizeBytes: bytes.length,
    truncated: Buffer.byteLength(bounded) < bytes.length,
  } as const;
}

/**
 * Reads a path only when it resolves to a regular file.
 *
 * @param fs - Host filesystem abstraction.
 * @param path - File path to resolve.
 * @param signal - Cancellation signal.
 * @returns File text, or `undefined` for missing and non-file targets.
 */
async function readHostText(
  fs: HostFs,
  path: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  const target = await fs.resolve(path, { signal });
  const info = await fs.stat(target, signal);
  if (!info || info.type !== "file") return undefined;
  return fs.readText(target, signal);
}

/**
 * Checks for a host path while preserving cancellation through lookup failures.
 *
 * @param fs - Host filesystem abstraction.
 * @param path - Path to inspect.
 * @param signal - Cancellation signal.
 * @param type - Optional required file type.
 * @returns Whether the requested path exists with the required type.
 */
async function hostExists(
  fs: HostFs,
  path: string,
  signal: AbortSignal,
  type?: "file",
): Promise<boolean> {
  try {
    const target = await fs.resolve(path, { signal });
    const info = await fs.stat(target, signal);
    return info !== undefined && (type === undefined || info.type === type);
  } catch {
    signal.throwIfAborted();
    return false;
  }
}
