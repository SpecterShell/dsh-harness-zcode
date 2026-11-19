/**
 * ZCode-compatible file, shell, and search tools.
 *
 * This row enforces the current Agent's sandbox policy, integrates file
 * observations with DSH's write/edit authorization, and records file touches
 * used by post-compaction restore. Glob and Grep are registered conditionally;
 * Bash supplies the embedded search branch when dedicated search tools are off.
 */
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-working-directory";
import { defineTool, ToolArgsError, ToolContextUnavailableError } from "@deepseek-ai/dsh-tools";
import { FsError, type FsTarget, type FsVersion, type FsWriteIntent } from "@deepseek-ai/dsh-fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import {
  computeHunkDiffs,
  editPresentationMeta,
  globPresentationMeta,
  grepPresentationMeta,
  readPresentationMeta,
  writePresentationMeta,
} from "./presentation.ts";
import { ZCodeFileTouches } from "./touches.ts";
import type { ZCodeObservationPolicy } from "../observation.ts";

export * from "./presentation.ts";
export * from "./touches.ts";

export const name = "zcode-tools";
export const inject = ["tools", "fs", "workingDirectory", "shell", "sandboxPolicy"];
export const zcodeFileTouches = new ZCodeFileTouches();
const zcodeReadDefinitions = new WeakSet<object>();

/**
 * Identifies the Read definition owned by this module.
 *
 * Compaction uses this identity check before executing a scoped Read, so a
 * profile tool with the same public name cannot bypass the ZCode read path.
 *
 * @param value Candidate tool definition.
 */
export function isZCodeReadDefinition(value: unknown): boolean {
  return typeof value === "object" && value !== null && zcodeReadDefinitions.has(value);
}

export const READ_LIMIT = 2_000;
const READ_MAX_BYTES = 256 * 1024;
const SEARCH_LIMIT = 250;
const OUTPUT_MAX_BYTES = 30_000;
const CWD_MARKER = "__ZCODE_CWD__";

type SearchMode = "bash" | "tools";

interface ZCodeSettings {
  tools(): { searchMode: SearchMode };
}

interface SandboxExecutionPolicy {
  mode: "read-only" | "workspace-write" | "danger-full-access";
  workspaceRoot: string;
  additionalWritableRoots?: readonly string[];
  sessionId?: any;
}

interface SandboxPolicyService {
  resolve(request: { session: any }): SandboxExecutionPolicy;
}

interface ShellOutput {
  text: string;
  truncated: boolean;
  spillPath?: string;
}

interface ShellRunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  stdout: ShellOutput;
  stderr: ShellOutput;
  sandbox?: { denied: boolean };
}

interface ShellService {
  resolve(request: {
    command: string;
    workdir: string;
    timeoutMs: number;
    onExpiry: "kill";
    stdoutMaxBytes: number;
    signal: AbortSignal;
    sandboxPolicy: SandboxExecutionPolicy;
  }): unknown;
  execute(spec: unknown): Promise<{ result(): Promise<ShellRunResult> }>;
}

/**
 * Resolves and reads one regular file through the host filesystem.
 *
 * The stat size is checked before decoding to keep Read below its byte budget.
 * The returned version belongs to that stat and is suitable for a subsequent
 * `fs/observed` event.
 *
 * @param ctx Host context exposing the filesystem service.
 * @param requestedPath User-provided path, resolved relative to `workingDirectory`.
 * @param workingDirectory Agent working directory used for relative resolution.
 * @param signal Cancellation signal forwarded to every filesystem operation.
 * @returns The resolved target, canonical path, decoded text, split lines, and version.
 * @throws If the path is missing, is not a regular file, or exceeds the byte cap.
 */
export async function readZCodeFileSnapshot(
  ctx: Pick<Context, "fs">,
  requestedPath: string,
  workingDirectory: string,
  signal: AbortSignal,
): Promise<{
  target: FsTarget;
  canonicalPath: string;
  text: string;
  lines: string[];
  version?: any;
}> {
  const file = await ctx.fs.resolve(requestedPath, { cwd: workingDirectory, signal });
  const info = await ctx.fs.stat(file, signal);
  if (info === undefined) throw new Error(`File not found: ${requestedPath}`);
  if (info.type !== "file") throw new Error(`Not a regular file: ${requestedPath}`);
  if (info.size !== undefined && info.size > READ_MAX_BYTES) {
    throw new Error(`File exceeds Read limit of ${READ_MAX_BYTES} bytes`);
  }
  const text = await ctx.fs.readText(file, signal);
  return {
    target: file,
    canonicalPath: ctx.fs.processPath(file),
    text,
    lines: text.split(/\r?\n/u),
    version: info.version,
  };
}

/**
 * Returns the live settings service when the host row is mounted.
 *
 * @param ctx Context that may provide `zcodeSettings`.
 */
function settings(ctx: Context): ZCodeSettings | undefined {
  return ctx.get("zcodeSettings" as never) as ZCodeSettings | undefined;
}

/** Return the preset-private native observation policy when composed. */
function observationPolicy(ctx: Context): ZCodeObservationPolicy | undefined {
  return ctx.get("zcodeObservationPolicy" as never) as ZCodeObservationPolicy | undefined;
}

/** Publish one authoritative observation to host policy and ZCode fallback. */
function observe(
  ctx: Context,
  target: FsTarget,
  observation: { kind: "absent" } | { kind: "present"; version: any },
  actor: object,
): void {
  ctx.emit("fs/observed", target, observation, actor);
  observationPolicy(ctx)?.observe(target, observation, actor);
}

/** Resolve the ZCode create-or-replace guard when no host policy decided. */
async function zcodeWriteIntent(ctx: Context, target: FsTarget, actor: object): Promise<FsWriteIntent> {
  const fallback = () => ({ kind: "createIfAbsent" } as const);
  return await observationPolicy(ctx)?.writeIntent(target, actor, fallback) ?? fallback();
}

/** Resolve the ZCode edit version when no host policy decided. */
async function zcodeEditIntent(
  ctx: Context,
  target: FsTarget,
  actor: object,
): Promise<{ version: FsVersion }> {
  const fallback = (): { version: FsVersion } => {
    throw new FsError(
      `edit requires reading "${target.displayPath}" first; no observation policy authorized this mutation`,
      "FS_NOT_OBSERVED",
    );
  };
  return await observationPolicy(ctx)?.editIntent(target, actor, fallback) ?? fallback();
}

/**
 * Resolves the current search branch, defaulting to Bash-compatible search.
 *
 * @param ctx Context used to read live settings.
 */
function searchMode(ctx: Context): SearchMode {
  return settings(ctx)?.tools().searchMode ?? "bash";
}

/**
 * Requires tool execution to be attached to an Agent.
 *
 * File observations, working directories, and sandbox policies are all
 * session-scoped, so running without an Agent would risk cross-session state.
 *
 * @param exec Tool execution context that must contain an Agent.
 */
function requireAgent(exec: { agent?: unknown }): any {
  if (exec.agent === undefined) throw new ToolContextUnavailableError("ZCode tools require an Agent");
  return exec.agent;
}

/**
 * Resolves the sandbox policy for the executing Agent's session.
 *
 * Missing enforcement fails closed instead of allowing filesystem or shell
 * work without the profile's selected permission mode.
 *
 * @param ctx Context that provides the sandbox policy service.
 * @param exec Agent-bound tool execution context.
 */
function sandboxPolicy(ctx: Context, exec: { agent?: unknown }): SandboxExecutionPolicy {
  const agent = requireAgent(exec);
  const service = ctx.get("sandboxPolicy" as never) as SandboxPolicyService | undefined;
  if (service === undefined) throw new ToolContextUnavailableError("ZCode tools require sandbox policy enforcement");
  return service.resolve({ session: agent.session });
}

/**
 * Returns the sandbox-aware shell service or fails closed when it is absent.
 *
 * @param ctx Context that must provide the shell service.
 */
function shellService(ctx: Context): ShellService {
  const service = ctx.get("shell" as never) as ShellService | undefined;
  if (service === undefined) throw new ToolContextUnavailableError("ZCode command tools require the sandboxed shell service");
  return service;
}

/**
 * Returns the Agent's persistent working directory.
 *
 * @param ctx Host context with the working-directory service.
 * @param exec Agent-bound execution and cancellation state.
 */
async function cwd(ctx: Context, exec: { agent?: unknown; signal: AbortSignal }): Promise<string> {
  const agent = requireAgent(exec);
  return ctx.workingDirectory.ensure(agent, exec.signal);
}

/**
 * Resolves a tool path and retains both its canonical identity and request cwd.
 *
 * The request cwd is stored with touch records so later policy checks can
 * reconstruct relative spellings after the Agent changes directory.
 *
 * @param ctx Host context exposing filesystem and working-directory services.
 * @param exec Agent-bound execution and cancellation state.
 * @param requestedPath Path supplied to Write or Edit.
 */
async function target(
  ctx: Context,
  exec: { agent?: unknown; signal: AbortSignal },
  requestedPath: string,
): Promise<{ target: FsTarget; canonicalPath: string; requestedCwd: string }> {
  if (requestedPath.trim().length === 0) throw new ToolArgsError(["path must be non-empty"]);
  const requestedCwd = await cwd(ctx, exec);
  const resolved = await ctx.fs.resolve(requestedPath, { cwd: requestedCwd, signal: exec.signal });
  return { target: resolved, canonicalPath: ctx.fs.processPath(resolved), requestedCwd };
}

/**
 * Caps rendered text by UTF-8 bytes.
 *
 * Buffer slicing can stop inside a multibyte character; the trailing
 * replacement character is removed before the truncation notice is appended.
 *
 * @param text Text to render.
 * @param maxBytes Maximum UTF-8 byte count including the truncation suffix.
 */
function truncateBytes(text: string, maxBytes = OUTPUT_MAX_BYTES): { text: string; truncated: boolean } {
  const bytes = Buffer.byteLength(text);
  if (bytes <= maxBytes) return { text, truncated: false };
  const suffix = "\n… output truncated";
  const kept = Buffer.from(text).subarray(0, Math.max(0, maxBytes - Buffer.byteLength(suffix)));
  return { text: kept.toString("utf8").replace(/\uFFFD$/u, "") + suffix, truncated: true };
}

/**
 * Quotes one value as a literal POSIX shell word.
 *
 * @param value Untrusted argument that must not be expanded by the shell.
 */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Builds a shell command from literal argv values without shell expansion.
 *
 * @param argv Arguments to quote and join.
 */
function shellCommand(argv: readonly string[]): string {
  return argv.map(shellQuote).join(" ");
}

/**
 * Recovers complete stdout from the shell spill file when capture was capped.
 *
 * Bash needs the complete stream to find its trailing cwd marker even when the
 * user-visible result will later be truncated to the tool output budget.
 *
 * @param ctx Context used to read a spill file.
 * @param output Captured stream metadata from the shell provider.
 * @param signal Cancellation signal for spill resolution and reading.
 */
async function fullOutput(ctx: Context, output: ShellOutput, signal: AbortSignal): Promise<string> {
  if (!output.truncated || output.spillPath === undefined) return output.text;
  const spill = await ctx.fs.resolve(output.spillPath, { signal });
  return ctx.fs.readText(spill, signal);
}

/**
 * Runs one command through the host shell with the Agent's sandbox policy.
 *
 * @param ctx Context providing shell and sandbox services.
 * @param exec Agent-bound execution and cancellation state.
 * @param request Command, cwd, timeout, and stdout capture budget.
 * @returns The settled shell result after the provider kills expired commands.
 */
async function executeShell(
  ctx: Context,
  exec: { agent?: unknown; signal: AbortSignal },
  request: { command: string; workdir: string; timeoutMs: number; stdoutMaxBytes: number },
): Promise<ShellRunResult> {
  const shell = shellService(ctx);
  const spec = shell.resolve({
    ...request,
    onExpiry: "kill",
    signal: exec.signal,
    sandboxPolicy: sandboxPolicy(ctx, exec),
  });
  return (await shell.execute(spec)).result();
}

/**
 * Renders a path relative to the workdir when it stays inside that directory.
 *
 * @param path Canonical path to display.
 * @param workdir Base directory for a safe relative spelling.
 */
function displayPath(path: string, workdir: string): string {
  const rel = relative(workdir, path);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel.split(sep).join("/") : path;
}

/**
 * Records the latest canonical touch for an Agent.
 *
 * Search touches support diagnostics but do not qualify for compaction restore;
 * restore later filters the ledger to Read, Write, and Edit.
 *
 * @param touches Per-Agent touch store.
 * @param exec Execution context whose Agent owns the record.
 * @param path Canonical path used as the record key.
 * @param requestedPath Original or display path associated with the call.
 * @param sourceTool Tool that produced the touch.
 * @param requestedCwd Cwd used to resolve a relative file mutation request.
 */
function noteTouch(
  touches: ZCodeFileTouches,
  exec: { agent?: unknown },
  path: string,
  requestedPath: string,
  sourceTool: "read" | "write" | "edit" | "glob" | "grep",
  requestedCwd?: string,
): void {
  if (exec.agent !== undefined) {
    touches.record(exec.agent as any, {
      path,
      requestedPath,
      sourceTool,
      ...(requestedCwd === undefined ? {} : { requestedCwd }),
    });
  }
}

/**
 * Registers the ZCode tool surface on a Cordis context.
 *
 * Read emits a present observation only for a complete file view. Write and
 * Edit obtain mutation intent through filesystem policy hooks and publish the
 * resulting version after success. Every shell-backed tool resolves the
 * session sandbox policy before execution.
 *
 * @param ctx Cordis context on which the tools are registered.
 */
export function apply(ctx: Context): void {
  const touches = zcodeFileTouches;

  const readDefinition = defineTool({
    name: "Read",
    description: [
      "Reads a file from the local filesystem.",
      "",
      "- `file_path` must be an absolute path.",
      `- Reads up to ${READ_LIMIT} lines by default.`,
      "- Results use cat -n style line numbers starting at 1.",
    ].join("\n"),
    parameters: {
      file_path: { type: "string", required: true, description: "The absolute path to the file to read" },
      offset: { type: "number", description: "The 0-based line offset to start reading from" },
      limit: { type: "number", description: "The number of lines to read" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          type: { type: "string", required: true, const: "text" },
          filePath: { type: "string", required: true },
          content: { type: "string", required: true },
          numLines: { type: "integer", required: true },
          startLine: { type: "integer", required: true },
          totalLines: { type: "integer", required: true },
          truncated: { type: "boolean" },
        },
      },
      render: (_args, value) => [{ type: "text", text: value.content }],
      presentationMeta: (_args, value) => readPresentationMeta(value),
    },
    isConcurrencySafe: () => true,
    /**
     * Reads a bounded line window and records the canonical file touch.
     *
     * Missing paths emit an absent observation. Only an offset-zero,
     * non-truncated result emits a present observation, because a partial read
     * must not authorize a later overwrite or edit.
     */
    async execute(args, exec) {
      const offset = args.offset ?? 0;
      const limit = args.limit ?? READ_LIMIT;
      if (args.file_path.trim().length === 0) throw new ToolArgsError(["path must be non-empty"]);
      if (!Number.isInteger(offset) || offset < 0) throw new ToolArgsError(["offset must be a non-negative integer"]);
      if (!Number.isInteger(limit) || limit < 1) throw new ToolArgsError(["limit must be a positive integer"]);
      const requestedCwd = await cwd(ctx, exec);
      let snapshot;
      try {
        snapshot = await readZCodeFileSnapshot(ctx, args.file_path, requestedCwd, exec.signal);
      } catch (error) {
        const missing = await ctx.fs.resolve(args.file_path, { cwd: requestedCwd, signal: exec.signal });
        if (await ctx.fs.stat(missing, exec.signal) === undefined) {
          observe(ctx, missing, { kind: "absent" }, exec);
        }
        throw error;
      }
      const lines = snapshot.lines;
      const selected = lines.slice(offset, offset + limit);
      const content = selected.map((line, index) => `${offset + index + 1}\t${line}`).join("\n");
      const truncated = offset + selected.length < lines.length;
      const complete = offset === 0 && !truncated;
      noteTouch(touches, exec, snapshot.canonicalPath, args.file_path, "read", requestedCwd);
      if (complete) {
        observe(ctx, snapshot.target, { kind: "present", version: snapshot.version }, exec);
      }
      return {
        type: "text" as const,
        filePath: snapshot.canonicalPath,
        content,
        numLines: selected.length,
        startLine: offset + 1,
        totalLines: lines.length,
        ...(truncated ? { truncated: true } : {}),
      };
    },
  });
  zcodeReadDefinitions.add(readDefinition);
  ctx.tools.register(readDefinition);

  ctx.tools.register(defineTool({
    name: "Write",
    description: "Writes a file to the local filesystem, overwriting if one exists.",
    parameters: {
      file_path: { type: "string", required: true, description: "The absolute path to the file to write" },
      content: { type: "string", required: true, description: "The content to write to the file" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          type: { type: "string", required: true, enum: ["create", "update"] },
          filePath: { type: "string", required: true },
          content: { type: "string", required: true },
          originalFile: { required: true, oneOf: [{ type: "string" }, { type: "null" }] },
        },
      },
      render: (_args, value) => [{
        type: "text",
        text: value.type === "create"
          ? `File created successfully at: ${value.filePath} (file state is current in your context — no need to Read it back)`
          : `The file ${value.filePath} has been updated successfully. (file state is current in your context — no need to Read it back)`,
      }],
      presentationMeta: (_args, value) => writePresentationMeta(value),
    },
    /**
     * Writes text using the filesystem's write-intent policy.
     *
     * The fallback permits creation only. Overwriting an existing file
     * therefore requires an observation policy to provide stronger intent.
     * Successful writes publish the new version for subsequent mutations.
     * Text encoding and newline bytes are delegated to the host `writeText`.
     */
    async execute(args, exec) {
      const resolved = await target(ctx, exec, args.file_path);
      const intent = await ctx.waterfall(
        "fs/write-intent",
        resolved.target,
        exec,
        () => zcodeWriteIntent(ctx, resolved.target, exec),
      );
      const outcome = await ctx.fs.writeText(
        resolved.target,
        args.content,
        intent,
        exec.signal,
        sandboxPolicy(ctx, exec),
      );
      noteTouch(touches, exec, resolved.canonicalPath, args.file_path, "write", resolved.requestedCwd);
      observe(ctx, resolved.target, { kind: "present", version: outcome.version }, exec);
      return {
        type: outcome.operation,
        filePath: resolved.canonicalPath,
        content: outcome.after,
        originalFile: outcome.before,
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: "Edit",
    description: [
      "Performs exact string replacement in a file.",
      "",
      "- `old_string` must match exactly and be unique unless `replace_all` is true.",
    ].join("\n"),
    parameters: {
      file_path: { type: "string", required: true, description: "The absolute path to the file to modify" },
      old_string: { type: "string", required: true, description: "The text to replace" },
      new_string: { type: "string", required: true, description: "The replacement text" },
      replace_all: { type: "boolean", description: "Replace all occurrences. Defaults to false." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          filePath: { type: "string", required: true },
          oldString: { type: "string", required: true },
          newString: { type: "string", required: true },
          originalFile: { type: "string", required: true },
          diffs: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                path: { type: "string", required: true },
                oldText: { required: true, oneOf: [{ type: "string" }, { type: "null" }] },
                newText: { type: "string", required: true },
              },
            },
          },
          replaceAll: { type: "boolean", required: true },
        },
      },
      render: (args, value) => [{
        type: "text",
        text: args.replace_all === true
          ? `The file ${value.filePath} has been updated. All occurrences were successfully replaced.`
          : `The file ${value.filePath} has been updated successfully.`,
      }],
      presentationMeta: (_args, value) => editPresentationMeta(value),
    },
    /**
     * Applies exact text replacement after edit-intent authorization.
     *
     * The fallback throws `FS_NOT_OBSERVED`, so a missing, partial, stale, or
     * otherwise unauthorized observation cannot edit the file. Byte and line
     * ending behavior is delegated to the host filesystem's `editText`.
     */
    async execute(args, exec) {
      if (args.old_string.length === 0) throw new ToolArgsError(["old_string must be non-empty"]);
      if (args.old_string === args.new_string) throw new ToolArgsError(["old_string and new_string must differ"]);
      const resolved = await target(ctx, exec, args.file_path);
      const intent = await ctx.waterfall(
        "fs/edit-intent",
        resolved.target,
        exec,
        () => zcodeEditIntent(ctx, resolved.target, exec),
      );
      const outcome = await ctx.fs.editText(
        resolved.target,
        {
          oldString: args.old_string,
          newString: args.new_string,
          replaceAll: args.replace_all ?? false,
        },
        intent,
        exec.signal,
        sandboxPolicy(ctx, exec),
      );
      noteTouch(touches, exec, resolved.canonicalPath, args.file_path, "edit", resolved.requestedCwd);
      observe(ctx, resolved.target, { kind: "present", version: outcome.version }, exec);
      return {
        filePath: resolved.canonicalPath,
        oldString: args.old_string,
        newString: args.new_string,
        originalFile: outcome.before,
        diffs: computeHunkDiffs(resolved.canonicalPath, outcome.before, outcome.after),
        replaceAll: args.replace_all ?? false,
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: "Bash",
    description: "Executes a Bash command. The session working directory persists across calls; shell variables and functions do not.",
    parameters: {
      command: { type: "string", required: true, description: "The command to execute" },
      timeout: { type: "number", description: "Optional timeout in milliseconds (maximum 600000)" },
      description: { type: "string", description: "Clear, concise description of what this command does" },
    },
    timeoutMs: 600_000,
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          stdout: { type: "string", required: true },
          stderr: { type: "string", required: true },
          status: { type: "string", required: true, enum: ["completed", "failed", "cancelled", "spawn_error"] },
          exitCode: { oneOf: [{ type: "integer" }, { type: "null" }] },
          signal: { oneOf: [{ type: "string" }, { type: "null" }] },
          cwd: { type: "string", required: true },
          interrupted: { type: "boolean", required: true },
          stdoutTruncated: { type: "boolean" },
          stderrTruncated: { type: "boolean" },
        },
      },
      render: (_args, value) => [{
        type: "text",
        text: [value.stdout, value.stderr, `[exit code: ${value.exitCode ?? "signal"}]`].filter(Boolean).join("\n"),
      }],
      presentationMeta: (_args, value) => ({
        cwd: value.cwd,
        status: value.status,
        exitCode: value.exitCode ?? null,
        signal: value.signal ?? null,
        interrupted: value.interrupted,
      }),
    },
    /**
     * Executes one Bash command while persisting only its final directory.
     *
     * Each call gets a fresh shell, so variables and functions do not survive.
     * An EXIT trap appends a cwd marker. Complete spilled stdout is inspected
     * for that marker before the visible output is byte-capped. Cancelled or
     * timed-out calls skip marker recovery because their trap may be incomplete.
     */
    async execute(args, exec) {
      if (args.command.trim().length === 0) throw new ToolArgsError(["command must be non-empty"]);
      const timeout = args.timeout ?? 120_000;
      if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 600_000) {
        throw new ToolArgsError(["timeout must be between 1 and 600000 milliseconds"]);
      }
      const workdir = await cwd(ctx, exec);
      const prelude = searchMode(ctx) === "bash" ? embeddedSearchPrelude() : "";
      const script = `${prelude}
trap 'status=$?; printf "\\n${CWD_MARKER}%s\\n" "$PWD"; exit "$status"' EXIT
eval -- ${shellQuote(args.command)}`;
      const outcome = await executeShell(ctx, exec, {
        command: script,
        workdir,
        timeoutMs: timeout,
        stdoutMaxBytes: OUTPUT_MAX_BYTES,
      });
      let stdout = outcome.aborted || outcome.timedOut
        ? outcome.stdout.text
        : await fullOutput(ctx, outcome.stdout, exec.signal);
      const stderrResult = truncateBytes(outcome.stderr.text);
      const marker = outcome.aborted || outcome.timedOut ? -1 : stdout.lastIndexOf(`\n${CWD_MARKER}`);
      if (marker >= 0) {
        const nextCwd = stdout.slice(marker + CWD_MARKER.length + 1).trim();
        stdout = stdout.slice(0, marker);
        if (nextCwd.length > 0) await ctx.workingDirectory.set(requireAgent(exec), nextCwd, exec.signal);
      }
      const stdoutResult = truncateBytes(stdout);
      return {
        stdout: stdoutResult.text,
        stderr: stderrResult.text,
        status: outcome.aborted || outcome.timedOut
          ? "cancelled" as const
          : outcome.exitCode === 0 && outcome.sandbox?.denied !== true
            ? "completed" as const
            : "failed" as const,
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        cwd: workdir,
        interrupted: outcome.aborted || outcome.timedOut,
        ...(outcome.stdout.truncated || stdoutResult.truncated ? { stdoutTruncated: true } : {}),
        ...(outcome.stderr.truncated || stderrResult.truncated ? { stderrTruncated: true } : {}),
      };
    },
  }));

  registerSearchTools(ctx, touches);
}

/**
 * Defines the search helpers available inside Bash search mode.
 *
 * The functions exist only in the current command shell. `grep` prefers
 * ripgrep when installed and otherwise delegates to the system grep.
 */
function embeddedSearchPrelude(): string {
  return `
find() {
  command find "$@"
}
grep() {
  if command -v rg >/dev/null 2>&1; then
    command rg "$@"
  else
    command grep "$@"
  fi
}`;
}

/**
 * Registers dedicated Glob and Grep tools for `searchMode: "tools"`.
 *
 * Both tools execute ripgrep under the Agent's sandbox policy, treat exit code
 * 1 as an empty result, bound the model-facing page, and record matching file
 * paths without making those search touches eligible for restore.
 *
 * @param ctx Cordis context on which conditional tools are registered.
 * @param touches Per-Agent touch store shared with the core file tools.
 */
function registerSearchTools(ctx: Context, touches: ZCodeFileTouches): void {
  ctx.tools.register(defineTool({
    name: "Glob",
    description: 'Fast file pattern matching. Supports glob patterns like "**/*.js" or "src/**/*.ts". Returns matching file paths sorted by modification time.',
    parameters: {
      pattern: { type: "string", required: true, description: "The glob pattern to match files against" },
      path: { type: "string", description: "The directory to search in. Omit for the current working directory." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          durationMs: { type: "number", required: true },
          numFiles: { type: "integer", required: true },
          totalFiles: { type: "integer", required: true },
          filenames: { type: "array", required: true, items: { type: "string" } },
          truncated: { type: "boolean", required: true },
        },
      },
      render: (_args, value) => [{ type: "text", text: value.filenames.length ? value.filenames.join("\n") : "No files found" }],
      presentationMeta: (_args, value) => globPresentationMeta(value),
    },
    isConcurrencySafe: () => true,
    /** Returns at most 100 matches while preserving whether more were found. */
    async execute(args, exec) {
      const started = performance.now();
      const workdir = await cwd(ctx, exec);
      const root = args.path ? resolve(workdir, args.path) : workdir;
      const outcome = await executeShell(ctx, exec, {
        command: shellCommand(["rg", "--files", `--glob=${args.pattern}`, "--sort=modified", "--hidden", "--glob=!**/.git/**", "--", root]),
        workdir,
        timeoutMs: 120_000,
        stdoutMaxBytes: 2_000_000,
      });
      if (outcome.aborted || outcome.timedOut) throw new Error("Glob search was cancelled");
      if (outcome.exitCode !== 0 && outcome.exitCode !== 1) throw new Error(outcome.stderr.text);
      const all = outcome.stdout.text.split(/\r?\n/u).filter(Boolean);
      const filenames = all.slice(0, 100).map((path) => displayPath(path, workdir));
      for (const path of all.slice(0, 100)) noteTouch(touches, exec, resolve(path), displayPath(path, workdir), "glob");
      return {
        durationMs: Math.round(performance.now() - started),
        numFiles: filenames.length,
        totalFiles: all.length,
        filenames,
        truncated: outcome.stdout.truncated || all.length > 100,
      };
    },
  }), { when: () => searchMode(ctx) === "tools" });

  ctx.tools.register(defineTool({
    name: "Grep",
    description: "Content search built on ripgrep-compatible regular expressions.",
    parameters: {
      pattern: { type: "string", required: true, description: "The regular expression pattern to search for in file contents" },
      path: { type: "string", description: "File or directory to search. Defaults to current working directory." },
      glob: { type: "string", description: "Glob pattern to filter files" },
      output_mode: { type: "string", enum: ["content", "files_with_matches", "count"], description: "Defaults to files_with_matches." },
      "-i": { type: "boolean", description: "Case insensitive search" },
      head_limit: { type: "number", description: "Defaults to 250; 0 means unlimited." },
      offset: { type: "number", description: "Skip entries before applying head_limit." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          mode: { type: "string", required: true, enum: ["content", "files_with_matches", "count"] },
          durationMs: { type: "number", required: true },
          numFiles: { type: "integer", required: true },
          filenames: { type: "array", required: true, items: { type: "string" } },
          content: { type: "string" },
          cardFiles: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                path: { type: "string", required: true },
                matches: {
                  type: "array",
                  required: true,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      lineNumber: { type: "integer", required: true },
                      line: { type: "string", required: true },
                    },
                  },
                },
              },
            },
          },
          numMatches: { type: "integer" },
          truncated: { type: "boolean", required: true },
        },
      },
      render: (_args, value) => [{
        type: "text",
        text: value.content ?? (value.filenames.join("\n") || "No matches found"),
      }],
      presentationMeta: (_args, value) => grepPresentationMeta(value),
    },
    isConcurrencySafe: () => true,
    /**
     * Pages ripgrep output after capture.
     *
     * Content and count modes expose their selected lines as text; file mode
     * exposes the selected paths. Canonical paths are retained in touch state
     * even when the rendered paths are relative to the working directory.
     */
    async execute(args, exec) {
      const started = performance.now();
      const workdir = await cwd(ctx, exec);
      const root = args.path ? resolve(workdir, args.path) : workdir;
      const mode = args.output_mode ?? "files_with_matches";
      const argv = mode === "files_with_matches"
        ? ["--files-with-matches"]
        : mode === "count"
          ? ["--count"]
          : ["--line-number", "--with-filename", "--null"];
      if (args["-i"]) argv.push("--ignore-case");
      if (args.glob) argv.push(`--glob=${args.glob}`);
      argv.push("--", args.pattern, root);
      const outcome = await executeShell(ctx, exec, {
        command: shellCommand(["rg", ...argv]),
        workdir,
        timeoutMs: 120_000,
        stdoutMaxBytes: 2_000_000,
      });
      if (outcome.aborted || outcome.timedOut) throw new Error("Grep search was cancelled");
      if (outcome.exitCode !== 0 && outcome.exitCode !== 1) throw new Error(outcome.stderr.text);
      const all = outcome.stdout.text.split(/\r?\n/u).filter(Boolean);
      const offset = Math.max(0, Math.trunc(args.offset ?? 0));
      const limit = args.head_limit === 0 ? Number.MAX_SAFE_INTEGER : Math.max(1, Math.trunc(args.head_limit ?? SEARCH_LIMIT));
      const page = all.slice(offset, offset + limit);
      const paths = new Set<string>();
      const cardFiles = new Map<string, { path: string; matches: Array<{ lineNumber: number; line: string }> }>();
      for (const line of page) {
        const contentMatch = mode === "content" ? /^(.*)\0([1-9][0-9]*):(.*)$/u.exec(line) : null;
        const candidate = mode === "files_with_matches" ? line : contentMatch?.[1];
        if (candidate === undefined) continue;
        const canonical = isAbsolute(candidate) ? candidate : resolve(workdir, candidate);
        paths.add(canonical);
        noteTouch(touches, exec, canonical, displayPath(canonical, workdir), "grep");
        if (contentMatch !== null) {
          const path = displayPath(canonical, workdir);
          let file = cardFiles.get(path);
          if (file === undefined) {
            file = { path, matches: [] };
            cardFiles.set(path, file);
          }
          file.matches.push({ lineNumber: Number(contentMatch[2]), line: contentMatch[3]! });
        }
      }
      const filenames = [...paths].map((path) => displayPath(path, workdir));
      return {
        mode,
        durationMs: Math.round(performance.now() - started),
        numFiles: filenames.length,
        filenames: mode === "files_with_matches" ? page.map((path) => displayPath(path, workdir)) : [],
        ...(mode !== "files_with_matches" ? { content: page.map((line) => line.replace("\0", ":")).join("\n") } : {}),
        ...(mode === "content" ? { cardFiles: [...cardFiles.values()] } : {}),
        numMatches: all.length,
        truncated: outcome.stdout.truncated || offset + page.length < all.length,
      };
    },
  }), { when: () => searchMode(ctx) === "tools" });
}
