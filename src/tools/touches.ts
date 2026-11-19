/**
 * Per-Agent file-touch state shared by tools and post-compaction restore.
 *
 * Records use canonical paths as keys and weak Agent ownership so completed
 * sessions do not stay alive solely because they touched files.
 */
import type { Agent } from "@deepseek-ai/dsh-agent";

/** Tool operation that last established a file's place in the touch ledger. */
export type ZCodeFileTouchSource = "read" | "write" | "edit" | "glob" | "grep";

/** Latest known touch for one canonical file path. */
export interface ZCodeFileTouchRecord {
  /** Canonical path used as the per-Agent map key. */
  path: string;
  /** Original or display spelling associated with the tool call. */
  requestedPath: string;
  /** Working directory against which a relative request was resolved. */
  requestedCwd?: string;
  /** Tool that produced the latest touch. Restore accepts only read/write/edit. */
  sourceTool: ZCodeFileTouchSource;
  /** Per-Agent monotonic sequence number, not wall-clock time. */
  touchedAt: number;
}

/**
 * Maintains one latest touch per canonical path for each Agent.
 *
 * A later tool call replaces the prior record for that path. The monotonic
 * counter gives deterministic recency even when filesystem mtimes tie.
 */
export class ZCodeFileTouches {
  private readonly records = new WeakMap<Agent, Map<string, ZCodeFileTouchRecord>>();
  private readonly counters = new WeakMap<Agent, number>();

  /**
   * Returns the Agent's current touch map.
   *
   * Callers receive an empty detached map when the Agent has no state.
   *
   * @param agent Owner of the isolated touch ledger.
   */
  touches(agent: Agent): ReadonlyMap<string, ZCodeFileTouchRecord> {
    return this.records.get(agent) ?? new Map();
  }

  /**
   * Stores a touch and assigns its next per-Agent recency number.
   *
   * @param agent Owner of the isolated touch ledger.
   * @param touch Record fields other than the generated `touchedAt`.
   * @returns The record stored under `touch.path`.
   */
  record(
    agent: Agent,
    touch: Omit<ZCodeFileTouchRecord, "touchedAt">,
  ): ZCodeFileTouchRecord {
    const touchedAt = (this.counters.get(agent) ?? 0) + 1;
    this.counters.set(agent, touchedAt);
    const record = { ...touch, touchedAt };
    let records = this.records.get(agent);
    if (records === undefined) {
      records = new Map();
      this.records.set(agent, records);
    }
    records.set(touch.path, record);
    return record;
  }

  /**
   * Replaces all touch state for an Agent.
   *
   * Compaction uses this after restore so evicted or unreadable files no
   * longer qualify on the next pass. The counter resumes from the greatest
   * restored sequence number to keep future touches monotonic.
   *
   * @param agent Owner whose state is replaced.
   * @param entries Canonical-path records to install.
   */
  replace(
    agent: Agent,
    entries: ReadonlyMap<string, ZCodeFileTouchRecord> | Iterable<readonly [string, ZCodeFileTouchRecord]>,
  ): void {
    const records = new Map(entries);
    this.records.set(agent, records);
    let counter = 0;
    for (const record of records.values()) counter = Math.max(counter, record.touchedAt);
    this.counters.set(agent, counter);
  }
}
