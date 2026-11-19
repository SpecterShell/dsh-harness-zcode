/**
 * Prove prompt composition and the per-session snapshot: a complete persona
 * replaces every assembled section, sections keep a stable order, the
 * snapshot survives later input changes, and a fork inherits the parent copy.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { assembleSections, snapshotOf, snapshotSections } from '../../src/context/prompt.ts'
import {
  clearPromptSnapshot,
  copyPromptSnapshot,
  getPromptSnapshot,
  persistPromptSnapshot,
  replayPromptSnapshot,
} from '../../src/context/snapshots.ts'
import type { PromptSection } from '../../src/context/types.ts'

function section(name: string, order: number, text: string): PromptSection {
  return { name, text, order, cacheHint: 'stable' }
}

/** A session stand-in that records events, like the host session does. */
function fakeSession() {
  const events: Array<{ type: string; data: unknown }> = []
  return {
    events,
    append(type: string, data: unknown) {
      events.push({ type, data })
    },
    snapshotEvents() {
      return events
    },
  }
}

test('a complete persona replaces every assembled section', () => {
  const sections = assembleSections({
    persona: { name: 'persona', text: 'zcode', cacheHint: 'stable', complete: true },
    skills: [section('skills', 300, 'skills')],
    runtimeFacts: [section('facts', 400, 'facts')],
  })
  assert.deepEqual(
    sections.map((item) => item.name),
    ['persona'],
  )
})

test('an incomplete persona keeps the other sections in order', () => {
  const sections = assembleSections({
    persona: { name: 'persona', text: 'zcode', cacheHint: 'stable', complete: false },
    projectInstructions: [section('instructions', 200, 'rules')],
    toolSections: [section('tools', 500, 'tools')],
  })
  assert.deepEqual(
    sections.map((item) => item.name),
    ['persona', 'instructions', 'tools'],
  )
})

test('the fingerprint is stable for identical sections and changes with content', () => {
  const first = snapshotOf([section('persona', 100, 'a')], { provider: 'p', model: 'm' })
  const same = snapshotOf([section('persona', 100, 'a')], { provider: 'p', model: 'm' })
  const changed = snapshotOf([section('persona', 100, 'b')], { provider: 'p', model: 'm' })
  assert.equal(first.snapshotFingerprint, same.snapshotFingerprint)
  assert.notEqual(first.snapshotFingerprint, changed.snapshotFingerprint)
  assert.equal(first.model?.model, 'm')
})

test('a persisted snapshot wins over current sections and is immutable', () => {
  const scope = fakeSession()
  const stored = persistPromptSnapshot(scope, snapshotOf([section('persona', 100, 'old')]))
  assert.equal(getPromptSnapshot(scope), stored)

  const second = persistPromptSnapshot(scope, snapshotOf([section('persona', 100, 'new')]))
  assert.equal(second, stored, 'a second persist for the same model keeps the first snapshot')

  const current = [section('persona', 100, 'new')]
  assert.deepEqual(
    snapshotSections(current, stored).map((item) => item.text),
    ['old'],
  )
  assert.equal(Object.isFrozen(stored.sections[0]), true)
})

test('a snapshot survives a session reload by replaying the recorded event', () => {
  const original = fakeSession()
  const stored = persistPromptSnapshot(original, snapshotOf([section('persona', 100, 'kept')]))

  // A reloaded session has the same event log and a fresh object identity.
  const reloaded = { snapshotEvents: () => original.events }
  assert.equal(getPromptSnapshot(reloaded), stored)
  assert.equal(replayPromptSnapshot(reloaded)?.snapshotFingerprint, stored.snapshotFingerprint)
})

test('a different model replaces the snapshot', () => {
  const scope = fakeSession()
  const first = persistPromptSnapshot(
    scope,
    snapshotOf([section('persona', 100, 'old')], { provider: 'p', model: 'm1' }),
  )
  const second = persistPromptSnapshot(
    scope,
    snapshotOf([section('persona', 100, 'new')], { provider: 'p', model: 'm2' }),
  )
  assert.notEqual(second.snapshotFingerprint, first.snapshotFingerprint)
  assert.equal(getPromptSnapshot(scope)?.model?.model, 'm2')
})

test('a successful compaction clears the snapshot and a fork copies it', () => {
  const parent = fakeSession()
  const child = fakeSession()
  const stored = persistPromptSnapshot(parent, snapshotOf([section('persona', 100, 'parent')]))
  copyPromptSnapshot(parent, child)
  assert.equal(getPromptSnapshot(child), stored)

  clearPromptSnapshot(parent)
  assert.equal(getPromptSnapshot(parent), undefined)
  assert.equal(getPromptSnapshot(child), stored, 'the child keeps its own copy')
  assert.equal(getPromptSnapshot({ snapshotEvents: () => parent.events }), undefined)
})
