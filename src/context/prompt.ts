/** Orders system prompt sections and fingerprints the sections captured for a session. */

import { createHash } from "node:crypto";

import type { PromptSection, PromptSnapshot } from "./types.ts";

export const PROMPT_ORDER = {
  persona: 100,
  projectInstructions: 200,
  skills: 300,
  runtimeFacts: 400,
  tools: 500,
} as const;

export interface AssembleSectionsInput {
  readonly persona?: Omit<PromptSection, "order"> & { readonly order?: number };
  readonly projectInstructions?: readonly PromptSection[];
  readonly skills?: readonly PromptSection[];
  readonly runtimeFacts?: readonly PromptSection[];
  readonly toolSections?: readonly PromptSection[];
}

/**
 * A complete persona supplies the entire prompt. Otherwise sections sort by order, then name.
 * @param input - Persona and sections contributed by the active providers.
 */
export function assembleSections(input: AssembleSectionsInput): PromptSection[] {
  if (input.persona?.complete) {
    return [freezeSection({ ...input.persona, order: input.persona.order ?? PROMPT_ORDER.persona })];
  }

  return [
    ...(input.persona
      ? [{ ...input.persona, order: input.persona.order ?? PROMPT_ORDER.persona }]
      : []),
    ...(input.projectInstructions ?? []),
    ...(input.skills ?? []),
    ...(input.runtimeFacts ?? []),
    ...(input.toolSections ?? []),
  ]
    .map(freezeSection)
    .sort((left, right) => left.order - right.order || left.name.localeCompare(right.name));
}

/**
 * Copies and freezes the ordered sections and hashes their serialized representation with the model identity.
 * @param sections - Prompt sections in presentation order.
 * @param model - Optional provider and model associated with the snapshot.
 */
export function snapshotOf(
  sections: readonly PromptSection[],
  model?: PromptSnapshot["model"],
): PromptSnapshot {
  const copied = sections.map((section) => freezeSection({ ...section }));
  const canonical = JSON.stringify({ model, sections: copied });
  return Object.freeze({
    ...(model ? { model: Object.freeze({ ...model }) } : {}),
    sections: Object.freeze(copied),
    snapshotFingerprint: createHash("sha256").update(canonical).digest("hex"),
  });
}

/**
 * Uses the persisted section list when a snapshot exists.
 * @param current - Sections assembled for this request.
 * @param persisted - Snapshot recovered for this session.
 */
export function snapshotSections(
  current: readonly PromptSection[],
  persisted?: PromptSnapshot | null,
): readonly PromptSection[] {
  return persisted ? persisted.sections : current;
}

function freezeSection(section: PromptSection): PromptSection {
  return Object.freeze({ ...section });
}
