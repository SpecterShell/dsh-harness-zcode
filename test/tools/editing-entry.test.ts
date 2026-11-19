/**
 * Editing through the normal shipped entry: the ZCode tool row mounted the way
 * a deployment mounts it, with no observation policy mounted by the test.
 *
 * The contract under test is the fail-closed default at the tool waterfall
 * seam. Without the shipped observation row, a mutation must refuse rather than
 * run with no observer; with the row present, only a complete Read authorizes
 * it. Truncated and oversized reads must never authorize an overwrite, and a
 * refusal must leave the file byte-for-byte intact.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { toolHost } from '../fixtures/tool-host.ts'


/** Raw bytes, so a refusal that still rewrote the file cannot pass. */
async function hex(path: string): Promise<string> {
  return (await readFile(path)).toString('hex')
}

await test('without the observation row an edit and an existing-file write fail closed', async t => {
  const app = await toolHost(t, { observe: false })
  const file = join(app.workspace, 'no-row.txt')
  const initial = 'alpha\r\nbeta\r\n'
  await writeFile(file, initial)
  const before = Buffer.from(initial, 'utf8').toString('hex')

  await app.call('Read', { file_path: file })
  await assert.rejects(
    app.call('Edit', { file_path: file, old_string: 'beta', new_string: 'BETA' }),
    /observation|observer|fail|closed|policy|FS_NOT_OBSERVED/iu,
  )
  assert.equal(await hex(file), before)

  await assert.rejects(
    app.call('Write', { file_path: file, content: 'replaced\n' }),
    /observation|observer|reading|overwrite|existing|policy|FS_NOT_OBSERVED/iu,
  )
  assert.equal(await hex(file), before)
})

await test('with the shipped observation row a complete Read authorizes the edit', async t => {
  const app = await toolHost(t)
  const file = join(app.workspace, 'with-row.txt')
  await writeFile(file, 'alpha\nbeta\n')

  await app.call('Read', { file_path: file })
  await app.call('Edit', { file_path: file, old_string: 'beta', new_string: 'BETA' })
  assert.equal(await hex(file), Buffer.from('alpha\nBETA\n', 'utf8').toString('hex'))
})

await test('an oversized Read errors and does not authorize an overwrite', async t => {
  const app = await toolHost(t)
  const file = join(app.workspace, 'oversized.txt')
  const big = 'x'.repeat(256 * 1024 + 1)
  await writeFile(file, big)
  const before = await hex(file)

  await assert.rejects(app.call('Read', { file_path: file }), /exceeds Read limit/u)
  await assert.rejects(app.call('Write', { file_path: file, content: 'small\n' }), /reading|observed|read|policy/iu)
  assert.equal(await hex(file), before)
})

await test('a truncated default Read does not authorize an overwrite', async t => {
  const app = await toolHost(t)
  const file = join(app.workspace, 'long.txt')
  await writeFile(file, Array.from({ length: 2100 }, (_, index) => `line-${index}`).join('\n') + '\n')
  const before = await hex(file)

  const page = await app.call('Read', { file_path: file })
  assert.equal(page.truncated, true, 'the default read stops at the line budget')
  assert.equal(page.numLines, 2000)

  await assert.rejects(app.call('Edit', { file_path: file, old_string: 'line-1', new_string: 'LINE-1' }), /reading|observed|read|policy/iu)
  await assert.rejects(app.call('Write', { file_path: file, content: 'short\n' }), /reading|observed|read|policy/iu)
  assert.equal(await hex(file), before)
})
