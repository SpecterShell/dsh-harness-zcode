/**
 * Prove the post-compaction restore window against the pinned ZCode rules:
 * newest five eligible files, reference notices for content over the per-file
 * cap, silent total-cap drops that still let later smaller files through, and
 * the always-excluded path markers.
 *
 * Source of the numbers: ZCode `runtime/helpers/compact-post-reminders.ts` at
 * commit fec9759, constants POST_COMPACT_MAX_FILES, POST_COMPACT_MAX_FILE_TOKENS,
 * POST_COMPACT_MAX_TOTAL_TOKENS and shouldSkipPostCompactReadStatePath.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  RESTORE_ALWAYS_EXCLUDED_PATH_MARKERS,
  RESTORE_MAX_FILES,
  RESTORE_MAX_FILE_TOKENS,
  RESTORE_MAX_TOTAL_TOKENS,
  buildRestoreEntries,
  selectRestoreCandidates,
} from '../../src/context/restore.ts'
import type { RestoreRead, RestoreState, RestoreStateEntry } from '../../src/context/types.ts'

function entry(
  path: string,
  touchedAt: number,
  overrides: Partial<RestoreStateEntry> = {},
): RestoreStateEntry {
  return {
    path: `/repo/${path}`,
    sourceTool: 'read',
    touchedAt,
    mtimeMs: touchedAt,
    ...overrides,
  }
}

function state(...entries: RestoreStateEntry[]): RestoreState {
  return new Map(entries.map((item) => [item.path, item]))
}

function content(path: string, text: string): RestoreRead {
  return { type: 'content', path: `/repo/${path}`, text }
}

test('the constants match the pinned upstream values', () => {
  assert.equal(RESTORE_MAX_FILES, 5)
  assert.equal(RESTORE_MAX_FILE_TOKENS, 5_000)
  assert.equal(RESTORE_MAX_TOTAL_TOKENS, 50_000)
  assert.deepEqual(
    [...RESTORE_ALWAYS_EXCLUDED_PATH_MARKERS],
    ['/.codex/memories/', '/docs/superpowers/plans/', '/.git/'],
  )
})

test('the newest five of seven candidates are selected, newest first', () => {
  const candidates = selectRestoreCandidates(
    state(
      entry('a.txt', 1),
      entry('b.txt', 2),
      entry('c.txt', 3),
      entry('d.txt', 4),
      entry('e.txt', 5),
      entry('f.txt', 6),
      entry('g.txt', 7),
    ),
  )
  assert.deepEqual(
    candidates.map((item) => item.path),
    ['/repo/g.txt', '/repo/f.txt', '/repo/e.txt', '/repo/d.txt', '/repo/c.txt'],
  )
})

test('a restored session entry orders by read time instead of a stale mtime', () => {
  const candidates = selectRestoreCandidates(
    state(
      entry('restored.txt', 10, { mtimeMs: 1, restoredFromSession: true }),
      entry('live.txt', 5, { mtimeMs: 5 }),
    ),
    { maxFiles: 2 },
  )
  assert.deepEqual(
    candidates.map((item) => item.path),
    ['/repo/restored.txt', '/repo/live.txt'],
  )
})

test('always-excluded markers win over recency', () => {
  const candidates = selectRestoreCandidates(
    state(
      entry('.git/config', 50),
      entry('.codex/memories/MEMORY.md', 49),
      entry('docs/superpowers/plans/plan.md', 48),
      entry('src/keep.ts', 1),
    ),
  )
  assert.deepEqual(candidates.map((item) => item.path), ['/repo/src/keep.ts'])
})

test('explicit exclusions and preserved paths are resolved before comparison', () => {
  const candidates = selectRestoreCandidates(
    state(entry('src/plan.md', 5), entry('src/kept.ts', 4), entry('src/other.ts', 3)),
    { excludedPaths: ['/repo/src/plan.md'], preservedPaths: ['/repo/src/kept.ts'] },
  )
  assert.deepEqual(candidates.map((item) => item.path), ['/repo/src/other.ts'])
})

test('relative preserved paths resolve against the session working directory', () => {
  const candidates = selectRestoreCandidates(
    state(entry('src/kept.ts', 4), entry('src/other.ts', 3)),
    { workingDirectory: '/repo', preservedPaths: ['src/kept.ts'] },
  )
  assert.deepEqual(candidates.map((item) => item.path), ['/repo/src/other.ts'])
})

test('a search touch never becomes a restore candidate', () => {
  // The tools seam publishes glob and grep touches in the same map. Restore
  // sources are read, write and edit only, so the selector must drop the rest
  // even when a runtime map arrives wider than the declared type.
  const leaky = new Map<string, RestoreStateEntry>([
    ['/repo/search-hit.ts', { ...entry('search-hit.ts', 99), sourceTool: 'grep' as never }],
    ['/repo/read.ts', entry('read.ts', 1)],
  ])
  const candidates = selectRestoreCandidates(leaky)
  assert.deepEqual(candidates.map((item) => item.path), ['/repo/read.ts'])
})

test('a content read under the caps is restored verbatim and kept in state', () => {
  const candidates = selectRestoreCandidates(state(entry('src/a.ts', 1)), {
    maxFiles: 1,
  })
  const { entries, state: next } = buildRestoreEntries(candidates, [content('src/a.ts', 'hello')])
  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.kind, 'content')
  assert.equal(entries[0]?.text, 'hello')
  assert.equal(entries[0]?.isPartialView, undefined)
  assert.equal(next.get('/repo/src/a.ts')?.sourceTool, 'read')
})

test('content over the per-file cap becomes a reference notice with a partial view', () => {
  const candidates = selectRestoreCandidates(state(entry('big.ts', 1)), { maxFiles: 1 })
  const big = 'x'.repeat((RESTORE_MAX_FILE_TOKENS + 10) * 4)
  const { entries, state: next } = buildRestoreEntries(candidates, [content('big.ts', big)])
  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.kind, 'reference')
  assert.match(entries[0]?.text ?? '', /too large to include/)
  assert.match(entries[0]?.text ?? '', /\/repo\/big\.ts/)
  assert.equal(entries[0]?.isPartialView, true)
  assert.equal(next.get('/repo/big.ts')?.isPartialView, true)
})

test('a too-large read becomes a reference notice and leaves no state entry', () => {
  const candidates = selectRestoreCandidates(state(entry('huge.bin', 1)), { maxFiles: 1 })
  const { entries, state: next } = buildRestoreEntries(candidates, [
    { type: 'too-large', path: '/repo/huge.bin' },
  ])
  assert.equal(entries[0]?.kind, 'reference')
  assert.equal(entries[0]?.isPartialView, undefined)
  assert.equal(next.size, 0)
})

test('denied and missing reads are skipped and still consumed the candidate slot', () => {
  const candidates = selectRestoreCandidates(
    state(entry('denied.ts', 3), entry('gone.ts', 2), entry('kept.ts', 1)),
    { maxFiles: 2 },
  )
  assert.deepEqual(
    candidates.map((item) => item.path),
    ['/repo/denied.ts', '/repo/gone.ts'],
  )
  const { entries } = buildRestoreEntries(candidates, [
    { type: 'denied', path: '/repo/denied.ts' },
    { type: 'missing', path: '/repo/gone.ts' },
  ])
  assert.deepEqual(entries, [])
})

test('total-cap overflow is dropped silently while a later smaller file still fits', () => {
  const candidates = selectRestoreCandidates(
    state(entry('first.ts', 3), entry('second.ts', 2), entry('small.ts', 1)),
    { maxFiles: 5 },
  )
  // Under the per-file cap, over the total cap once combined.
  const first = 'a'.repeat(4_900 * 4)
  const second = 'b'.repeat(4_900 * 4)
  const { entries } = buildRestoreEntries(
    candidates,
    [content('first.ts', first), content('second.ts', second), content('small.ts', 'tiny')],
    { maxTotalTokens: 6_000 },
  )
  assert.deepEqual(
    entries.map((item) => item.path),
    ['/repo/first.ts', '/repo/small.ts'],
  )
})

test('an empty candidate list restores nothing', () => {
  const { entries, state: next } = buildRestoreEntries([], [])
  assert.deepEqual(entries, [])
  assert.equal(next.size, 0)
})
