/**
 * Prove runtime microcompaction stays off unless enabled, clears the oldest
 * compactable tool results while keeping the newest five, and respects the
 * minimum-savings gate. Source: ZCode `compact/microcompact.ts` at fec9759.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MICROCOMPACT_ENABLED_BY_DEFAULT,
  MICROCOMPACT_KEEP_RECENT_TOOL_RESULTS,
  MICROCOMPACT_MIN_TOKEN_SAVINGS,
  microcompact,
} from '../../src/context/microcompaction.ts'

const estimate = (text: string) => Math.ceil(text.length / 4)

function entries(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    kind: 'tool-result' as const,
    text: `result ${index} ${'x'.repeat(400)}`,
  }))
}

test('microcompaction is off by default', () => {
  assert.equal(MICROCOMPACT_ENABLED_BY_DEFAULT, false)
  assert.equal(MICROCOMPACT_KEEP_RECENT_TOOL_RESULTS, 5)
  assert.equal(MICROCOMPACT_MIN_TOKEN_SAVINGS, 256)
  const result = microcompact(entries(10), { thresholdTokens: 1, estimateTokens: estimate })
  assert.equal(result.applied, false)
  assert.equal(result.clearedMessageCount, 0)
  assert.deepEqual(result.entries, entries(10))
})

test('above the threshold the oldest results are cleared and the newest five kept', () => {
  const input = entries(10)
  const result = microcompact(input, {
    enabled: true,
    thresholdTokens: 1,
    estimateTokens: estimate,
  })
  assert.equal(result.applied, true)
  assert.equal(result.clearedMessageCount, 5)
  assert.match(result.entries[0]?.text ?? '', /removed by microcompaction/)
  assert.equal(result.entries[5], input[5])
  assert.equal(result.entries[9], input[9])
  assert.ok(result.tokensSaved > 0)
})

test('below the threshold nothing changes', () => {
  const input = entries(3)
  const result = microcompact(input, {
    enabled: true,
    thresholdTokens: 10_000,
    estimateTokens: estimate,
  })
  assert.equal(result.applied, false)
  assert.deepEqual(result.entries, input)
})

test('the minimum-savings gate keeps the original entries', () => {
  const input = entries(10)
  const result = microcompact(input, {
    enabled: true,
    thresholdTokens: 1,
    minTokenSavings: 1_000_000,
    estimateTokens: estimate,
  })
  assert.equal(result.applied, false)
  assert.deepEqual(result.entries, input)
})

test('a non-compactable result is never cleared', () => {
  const input = [
    { kind: 'tool-result' as const, text: `pinned ${'x'.repeat(400)}`, compactable: false },
    ...entries(6),
  ]
  const result = microcompact(input, {
    enabled: true,
    thresholdTokens: 1,
    keepRecentToolResults: 5,
    minTokenSavings: 0,
    estimateTokens: estimate,
  })
  assert.equal(result.entries[0], input[0])
  assert.equal(result.clearedMessageCount, 1)
})

test('the default savings gate ignores a clear that frees too little', () => {
  const input = entries(6)
  // One cleared 400-character result saves about 100 tokens, under the 256 default.
  const result = microcompact(input, {
    enabled: true,
    thresholdTokens: 1,
    keepRecentToolResults: 5,
    estimateTokens: estimate,
  })
  assert.equal(result.applied, false)
  assert.deepEqual(result.entries, input)
})
