/** Shared records for prompt snapshots, bounded instruction reads and file restoration. */

export type PromptCacheHint = "stable" | "dynamic";

export interface PromptSection {
  readonly name: string;
  readonly text: string;
  readonly order: number;
  readonly cacheHint: PromptCacheHint;
  readonly complete?: boolean;
}

export interface PromptSnapshot {
  readonly model?: {
    readonly provider: string;
    readonly model: string;
  };
  readonly sections: readonly PromptSection[];
  readonly snapshotFingerprint: string;
}

export type RestoreSourceTool = "read" | "write" | "edit";

export interface RestoreStateEntry {
  readonly path: string;
  readonly requestedPath?: string;
  readonly requestedCwd?: string;
  readonly sourceTool: RestoreSourceTool;
  readonly touchedAt: number;
  readonly mtimeMs?: number;
  readonly restoredFromSession?: boolean;
  readonly isPartialView?: boolean;
}

export type RestoreState = ReadonlyMap<string, RestoreStateEntry>;

export interface RestoreCandidate extends RestoreStateEntry {}

/** Per-candidate read outcome. Denials and missing files are omitted from restored context. */
export type RestoreRead =
  | { readonly type: "content"; readonly path: string; readonly text: string }
  | { readonly type: "too-large"; readonly path: string }
  | { readonly type: "denied"; readonly path: string }
  | { readonly type: "missing"; readonly path: string };

export interface RestoreEntry {
  readonly path: string;
  readonly text: string;
  readonly kind: "content" | "reference";
  readonly tokens: number;
  readonly isPartialView?: boolean;
}

export interface InstructionSource {
  readonly path: string;
  readonly scope: "user" | "workspace";
  readonly text: string;
  readonly bytesRead: number;
  readonly sizeBytes: number;
  readonly truncated: boolean;
}

export interface MemoryIndexRead {
  readonly text: string;
  readonly truncated: boolean;
}
