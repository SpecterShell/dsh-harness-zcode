/**
 * Prove the memory index read and the extraction gate. The index is bounded and
 * cut on a character boundary; extraction runs only for an interactive turn,
 * which is the pinned headless-versus-interactive split.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  MEMORY_INDEX_FILE,
  readMemoryIndex,
  renderMemoryIndex,
  shouldExtractMemory,
} from '../../src/context/memory.ts'

async function memoryRoot(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'zcode-memory-'))
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })
  return root
}

test('a missing index reads as empty text without an error', async (t) => {
  const root = await memoryRoot(t)
  const index = await readMemoryIndex({ root })
  assert.deepEqual(index, { text: '', truncated: false })
  assert.equal(renderMemoryIndex(root, index), '')
})

test('the index is cut on a character boundary and reports truncation', async (t) => {
  const root = await memoryRoot(t)
  await writeFile(join(root, MEMORY_INDEX_FILE), `abcdefghij中tail`, 'utf8')
  const index = await readMemoryIndex({ root, budgetBytes: 12 })
  assert.equal(index.text, 'abcdefghij')
  assert.equal(index.truncated, true)
})

test('the rendered index keeps the system-reminder framing', async (t) => {
  const root = await memoryRoot(t)
  await writeFile(join(root, MEMORY_INDEX_FILE), '- note one\n', 'utf8')
  const text = renderMemoryIndex(root, await readMemoryIndex({ root }))
  assert.match(text, /^<system-reminder>/)
  assert.match(text, /note one/)
  assert.match(text, /<\/system-reminder>$/)
})

test('extraction runs only for an interactive turn', () => {
  assert.equal(shouldExtractMemory({ mode: 'interactive', source: 'turn' }), true)
  assert.equal(shouldExtractMemory({ mode: 'interactive', source: 'prompt' }), false)
  assert.equal(shouldExtractMemory({ mode: 'interactive', source: 'target' }), false)
  assert.equal(shouldExtractMemory({ mode: 'headless', source: 'turn' }), false)
  assert.equal(shouldExtractMemory({ mode: 'headless', source: 'prompt' }), false)
  assert.equal(shouldExtractMemory({ mode: 'headless', source: 'target' }), false)
})
