/**
 * Prove prompt composition and the per-session snapshot: a complete persona
 * replaces every assembled section, sections keep a stable order, the
 * snapshot survives later input changes, and a fork inherits the parent copy.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { assembleSections, snapshotOf, snapshotSections } from '../../src/context/prompt.ts'
import {
  clearPromptSnapshot,
  copyPromptSnapshot,
  getPromptSnapshot,
  persistPromptSnapshot,
  PROMPT_SNAPSHOT_EVENT,
  replayPromptSnapshot,
} from '../../src/context/snapshots.ts'
import type { PromptSection } from '../../src/context/types.ts'

let nextSession = 0

function section(name: string, order: number, text: string): PromptSection {
  return { name, text, order, cacheHint: 'stable' }
}

/** An independent host session that accepts plugin records without store lifecycle setup. */
function fakeSession() {
  nextSession += 1
  return Session.create(SessionId(`snapshot-test-${nextSession}`))
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
  assert.deepEqual(getPromptSnapshot(scope), stored)

  const second = persistPromptSnapshot(scope, snapshotOf([section('persona', 100, 'new')]))
  assert.deepEqual(second, stored, 'a second persist for the same model keeps the first snapshot')

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
  const reloaded = { snapshotEvents: () => original.snapshotEvents() }
  assert.deepEqual(getPromptSnapshot(reloaded), stored)
  assert.equal(replayPromptSnapshot(reloaded)?.snapshotFingerprint, stored.snapshotFingerprint)
})

test('snapshot persistence uses an ignorable namespaced plugin record', () => {
  const session = fakeSession()
  persistPromptSnapshot(session, snapshotOf([section('persona', 100, 'kept')]))
  const event = session.ownEvents()[0] as unknown as { type?: string; ignorable?: boolean }
  assert.equal(event?.type, PROMPT_SNAPSHOT_EVENT)
  assert.equal(event?.ignorable, true)
})

test('a host session can replay the namespaced snapshot record', () => {
  const original = fakeSession()
  const stored = persistPromptSnapshot(original, snapshotOf([section('persona', 100, 'kept')]))
  nextSession += 1
  const replayed = Session.create(
    SessionId(`snapshot-test-${nextSession}`),
    original.snapshotEvents(),
  )
  assert.deepEqual(replayPromptSnapshot(replayed), stored)
})

test('legacy snapshot events remain readable when already available', () => {
  const stored = snapshotOf([section('persona', 100, 'legacy')])
  const legacy = {
    snapshotEvents: () => [{ type: 'zcode/prompt-snapshot', data: { snapshot: stored } }],
  }
  assert.equal(replayPromptSnapshot(legacy), stored)
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
  assert.deepEqual(getPromptSnapshot(child), stored)

  clearPromptSnapshot(parent)
  assert.equal(getPromptSnapshot(parent), undefined)
  assert.deepEqual(getPromptSnapshot(child), stored, 'the child keeps its own copy')
  assert.equal(getPromptSnapshot({ snapshotEvents: () => parent.snapshotEvents() }), undefined)
})
