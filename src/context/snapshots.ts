/** Stores prompt snapshots in session events with a process-local cache for live scopes. */

import {
  appendPluginRecord,
  pluginRecordOf,
  Session,
  type SessionEvent,
} from "@deepseek-ai/dsh-session";

import type { PromptSnapshot } from "./types.ts";

export const PROMPT_SNAPSHOT_EVENT =
  "plugin:spectershell/dsh-harness-zcode/prompt-snapshot";
const LEGACY_PROMPT_SNAPSHOT_EVENT = "zcode/prompt-snapshot";

interface PromptSnapshotRecord {
  readonly snapshot?: PromptSnapshot;
  readonly cleared?: boolean;
}

declare module "@deepseek-ai/dsh-session" {
  interface PluginRecordMap {
    "plugin:spectershell/dsh-harness-zcode/prompt-snapshot": PromptSnapshotRecord;
  }
}

interface SnapshotEvent {
  readonly type?: string;
  readonly data?: unknown;
}

interface SnapshotSession {
  ownEvents?(): Iterable<SnapshotEvent>;
  snapshotEvents?(): Iterable<SnapshotEvent>;
}

const snapshots = new WeakMap<object, PromptSnapshot>();

/**
 * Checks replayed events before consulting the in-memory snapshots.
 * @param scope - Session or agent carrying a session.
 */
export function getPromptSnapshot(scope: object): PromptSnapshot | undefined {
  const session = sessionOf(scope);
  return replayPromptSnapshot(session) ?? snapshots.get(scope) ?? snapshots.get(session);
}

/**
 * Reuses the recorded snapshot for the same provider and model, even if live sections changed.
 * @param scope - Session or agent receiving the snapshot.
 * @param snapshot - Newly assembled prompt and model identity.
 */
export function persistPromptSnapshot(scope: object, snapshot: PromptSnapshot): PromptSnapshot {
  const session = sessionOf(scope);
  const existing = replayPromptSnapshot(session);
  if (
    existing &&
    existing.model?.provider === snapshot.model?.provider &&
    existing.model?.model === snapshot.model?.model
  ) {
    snapshots.set(scope, existing);
    snapshots.set(session, existing);
    return existing;
  }
  appendPluginRecord(session as unknown as Session, PROMPT_SNAPSHOT_EVENT, { snapshot });
  snapshots.set(scope, snapshot);
  snapshots.set(session, snapshot);
  return snapshot;
}

/**
 * Records a clear event when supported and evicts both cache keys.
 * @param scope - Session or agent whose snapshot should be cleared.
 */
export function clearPromptSnapshot(scope: object): boolean {
  const session = sessionOf(scope);
  const existed = getPromptSnapshot(scope) !== undefined;
  appendPluginRecord(session as unknown as Session, PROMPT_SNAPSHOT_EVENT, { cleared: true });
  snapshots.delete(scope);
  snapshots.delete(session);
  return existed;
}

/**
 * Carries a parent snapshot into a child using the usual persistence rules.
 * @param parent - Source session or agent.
 * @param child - Destination session or agent.
 */
export function copyPromptSnapshot(parent: object, child: object): PromptSnapshot | undefined {
  const snapshot = getPromptSnapshot(parent);
  if (snapshot) persistPromptSnapshot(child, snapshot);
  return snapshot;
}

/**
 * Reconstructs the latest snapshot in event order, honoring clear events.
 * @param session - Event source, optionally providing an inherited snapshot stream.
 */
export function replayPromptSnapshot(session: object): PromptSnapshot | undefined {
  const source = session as SnapshotSession;
  const events = source.snapshotEvents?.() ?? source.ownEvents?.();
  if (!events) return undefined;
  let snapshot: PromptSnapshot | undefined;
  for (const event of events) {
    const data = promptSnapshotRecordOf(event);
    if (!data) continue;
    if (data.cleared) snapshot = undefined;
    else if (data.snapshot) snapshot = data.snapshot;
  }
  return snapshot;
}

function promptSnapshotRecordOf(event: SnapshotEvent): PromptSnapshotRecord | undefined {
  const data =
    event.type === LEGACY_PROMPT_SNAPSHOT_EVENT
      ? event.data
      : pluginRecordOf(event as SessionEvent)?.type === PROMPT_SNAPSHOT_EVENT
        ? event.data
        : undefined;
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const record = data as PromptSnapshotRecord;
  if (record.cleared === true) return { cleared: true };
  return isPromptSnapshot(record.snapshot) ? { snapshot: record.snapshot } : undefined;
}

function isPromptSnapshot(value: unknown): value is PromptSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as Partial<PromptSnapshot>;
  if (typeof snapshot.snapshotFingerprint !== "string" || !Array.isArray(snapshot.sections)) {
    return false;
  }
  if (
    snapshot.model !== undefined &&
    (typeof snapshot.model.provider !== "string" || typeof snapshot.model.model !== "string")
  ) {
    return false;
  }
  return snapshot.sections.every(
    (section) =>
      section !== null &&
      typeof section === "object" &&
      typeof section.name === "string" &&
      typeof section.text === "string" &&
      typeof section.order === "number" &&
      (section.cacheHint === "stable" || section.cacheHint === "dynamic") &&
      (section.complete === undefined || typeof section.complete === "boolean"),
  );
}

function sessionOf(scope: object): object & SnapshotSession {
  return ((scope as { session?: object }).session ?? scope) as object & SnapshotSession;
}
