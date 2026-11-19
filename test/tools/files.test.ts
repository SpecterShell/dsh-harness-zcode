/**
 * Prove the dedicated Read/Write/Edit rows: real files, real registry, no shell.
 *
 * The touched-file record is part of the contract here, because the context
 * rows read it to decide what a session already saw.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { toolHost } from '../fixtures/tool-host.ts'

await test('Write creates, then updates, and Read returns numbered lines', async t => {
  const { call, workspace } = await toolHost(t)
  const file = join(workspace, 'notes.txt')

  const created = await call('Write', { file_path: file, content: 'alpha\nbeta\n' })
  assert.equal(created.type, 'create')
  assert.equal(created.originalFile, null)
  assert.equal(created.filePath, file)
  assert.equal(await readFile(file, 'utf8'), 'alpha\nbeta\n')

  const updated = await call('Write', { file_path: file, content: 'alpha\ngamma\n' })
  assert.equal(updated.type, 'update')
  assert.equal(updated.originalFile, 'alpha\nbeta\n')

  const read = await call('Read', { file_path: file })
  assert.equal(read.type, 'text')
  assert.equal(read.content, '1\talpha\n2\tgamma\n3\t')
  assert.equal(read.startLine, 1)
  assert.equal(read.numLines, 3)
  assert.equal(read.totalLines, 3)
  assert.equal(read.truncated, undefined)
})

await test('Read honors offset and limit and reports truncation', async t => {
  const { call, workspace } = await toolHost(t)
  const file = join(workspace, 'lines.txt')
  await writeFile(file, ['one', 'two', 'three', 'four'].join('\n'))

  const page = await call('Read', { file_path: file, offset: 1, limit: 2 })
  assert.equal(page.content, '2\ttwo\n3\tthree')
  assert.equal(page.startLine, 2)
  assert.equal(page.numLines, 2)
  assert.equal(page.truncated, true, 'lines remain after the page')

  const tail = await call('Read', { file_path: file, offset: 2, limit: 2 })
  assert.equal(tail.truncated, undefined, 'the last page is not truncated')
})

await test('Read rejects a missing file, a directory and a file over its byte limit', async t => {
  const { call, workspace } = await toolHost(t)
  await assert.rejects(call('Read', { file_path: join(workspace, 'absent.txt') }), /File not found/u)
  await assert.rejects(call('Read', { file_path: workspace }), /Not a regular file/u)

  const large = join(workspace, 'large.txt')
  await writeFile(large, 'x'.repeat(256 * 1024 + 1))
  await assert.rejects(call('Read', { file_path: large }), /exceeds Read limit/u)
})

await test('Read and Edit reject bad arguments without touching the file', async t => {
  const { call, workspace } = await toolHost(t)
  const file = join(workspace, 'arg.txt')
  await writeFile(file, 'a\nb\n')

  await assert.rejects(call('Read', { file_path: '' }), /path must be non-empty/u)
  await assert.rejects(call('Read', { file_path: file, offset: -1 }), /offset must be a non-negative integer/u)
  await assert.rejects(call('Read', { file_path: file, limit: 0 }), /limit must be a positive integer/u)
  await assert.rejects(call('Edit', { file_path: file, old_string: '', new_string: 'x' }), /old_string must be non-empty/u)
  await assert.rejects(call('Edit', { file_path: file, old_string: 'a', new_string: 'a' }), /must differ/u)
  assert.equal(await readFile(file, 'utf8'), 'a\nb\n')
})

await test('Edit replaces a unique match and refuses an ambiguous one', async t => {
  const { call, workspace } = await toolHost(t)
  const file = join(workspace, 'edit.txt')
  await writeFile(file, 'before\nkeep\nafter\n')
  // The observation row requires a full read of the current bytes first.
  await call('Read', { file_path: file })

  const edited = await call('Edit', { file_path: file, old_string: 'keep', new_string: 'changed' })
  assert.equal(edited.oldString, 'keep')
  assert.equal(edited.newString, 'changed')
  assert.equal(edited.originalFile, 'before\nkeep\nafter\n')
  assert.equal(await readFile(file, 'utf8'), 'before\nchanged\nafter\n')

  await writeFile(file, 'same\nsame\n')
  await call('Read', { file_path: file })
  await assert.rejects(
    call('Edit', { file_path: file, old_string: 'same', new_string: 'once' }),
    /matched 2 times/u,
  )
  assert.equal(await readFile(file, 'utf8'), 'same\nsame\n', 'an ambiguous edit changes nothing')

  const all = await call('Edit', { file_path: file, old_string: 'same', new_string: 'twice', replace_all: true })
  assert.equal(all.replaceAll, true)
  assert.equal(await readFile(file, 'utf8'), 'twice\ntwice\n')
})

await test('each file touch is recorded once per canonical path and tool', async t => {
  const { call, workspace, touches } = await toolHost(t)
  const file = join(workspace, 'touch.txt')
  await call('Write', { file_path: file, content: 'body\n' })
  await call('Read', { file_path: file })
  await call('Edit', { file_path: file, old_string: 'body', new_string: 'other' })

  const records = touches()
  assert.equal(records.size, 1, 'one canonical path, one record')
  const record = records.get(file)
  assert.ok(record, 'the file is recorded under its canonical path')
  assert.equal(record.sourceTool, 'edit', 'the latest tool that touched the file wins')
  assert.equal(record.requestedPath, file)
  assert.ok(record.touchedAt > 0)
})

await test('a tool call without an Agent is refused, so nothing can leak between sessions', async t => {
  const { host, workspace } = await toolHost(t)
  const tool = host.tools.get('Read')
  await assert.rejects(
    tool.execute({ file_path: join(workspace, 'x') }, { callId: 'c', name: 'Read', arguments: {}, signal: new AbortController().signal }),
    /require an Agent/u,
  )
})
