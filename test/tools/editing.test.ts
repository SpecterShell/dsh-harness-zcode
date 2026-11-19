/**
 * End-to-end editing through the registered Read/Edit/Write rows with the
 * deployment's read-before-edit policy and the executor's denial path mounted.
 *
 * The policy (`dsh-fs-observation-policy`) is the production read-state guard:
 * it keys observations per Agent from `fs/observed`, then rejects
 * `fs/write-intent` and `fs/edit-intent` for a target the Agent has not read,
 * or whose version changed since the read. Byte assertions use the file's raw
 * bytes so a denied or stale edit cannot silently rewrite them.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { toolHost } from '../fixtures/tool-host.ts'


/** Raw bytes of a file, as hex, for exact comparisons. */
async function hex(path: string): Promise<string> {
  return (await readFile(path)).toString('hex')
}

/** The fixture mounts the shipped observation row and the native executor. */
async function guarded(t: Parameters<typeof toolHost>[0], options: Parameters<typeof toolHost>[1] = {}) {
  return await toolHost(t, options)
}

const CRLF_BOM = '\uFEFFalpha\r\nbeta\r\ngamma\r\n'

await test('Edit before Read is refused and leaves the bytes untouched', async t => {
  const { call, workspace } = await guarded(t)
  const file = join(workspace, 'guarded.txt')
  await writeFile(file, CRLF_BOM)

  await assert.rejects(call('Edit', { file_path: file, old_string: 'beta', new_string: 'BETA' }), /without reading it first|requires reading/u)
  assert.equal(await hex(file), Buffer.from(CRLF_BOM, 'utf8').toString('hex'))
})

await test('Write over an unseen file is refused; a missing file may be created after reading it', async t => {
  const { call, workspace } = await guarded(t)
  const existing = join(workspace, 'existing.txt')
  await writeFile(existing, CRLF_BOM)
  await assert.rejects(call('Write', { file_path: existing, content: 'replaced\n' }), /without reading it first|requires reading/u)
  assert.equal(await hex(existing), Buffer.from(CRLF_BOM, 'utf8').toString('hex'))

  const fresh = join(workspace, 'fresh.txt')
  await assert.rejects(call('Read', { file_path: fresh }), /File not found/u)
  const created = await call('Write', { file_path: fresh, content: 'new\n' })
  assert.equal(created.type, 'create')
  assert.equal(await hex(fresh), Buffer.from('new\n', 'utf8').toString('hex'))
})

await test('Read then Edit succeeds and the result keeps the file line endings', async t => {
  const { call, workspace } = await guarded(t)
  const file = join(workspace, 'read-edit.txt')
  await writeFile(file, CRLF_BOM)

  await call('Read', { file_path: file })
  await call('Edit', { file_path: file, old_string: 'beta', new_string: 'BETA' })
  // The host strips the UTF-8 BOM on its write path and restores CRLF.
  assert.equal(await hex(file), Buffer.from('alpha\r\nBETA\r\ngamma\r\n', 'utf8').toString('hex'))
})

await test('Write keeps an LF payload when overwriting a CRLF file', async t => {
  const { call, workspace } = await guarded(t)
  const file = join(workspace, 'write-eol.txt')
  await writeFile(file, 'alpha\r\nbeta\r\n')

  await call('Read', { file_path: file })
  await call('Write', { file_path: file, content: 'one\ntwo\n' })
  assert.equal(await hex(file), Buffer.from('one\ntwo\n', 'utf8').toString('hex'))
})

await test('Edit uses the host first-4096-byte sample to choose line endings', async t => {
  const { call, workspace } = await guarded(t)
  const file = join(workspace, 'eol-sample.txt')
  const prefix = Array.from({ length: 700 }, () => 'prefix').join('\r\n') + '\r\n'
  const tail = Array.from({ length: 3000 }, () => 'tail').join('\n') + '\n'
  const initial = prefix + tail + 'UNIQUE-MARKER\n'
  await writeFile(file, initial)

  await call('Read', { file_path: file, limit: 4000 })
  await call('Edit', { file_path: file, old_string: 'UNIQUE-MARKER', new_string: 'replaced-marker' })
  const expected = (prefix + tail + 'replaced-marker\n').replace(/\r?\n/gu, '\r\n')
  assert.equal(await hex(file), Buffer.from(expected, 'utf8').toString('hex'))
})

await test('UTF-16LE is rejected as binary and a guarded overwrite leaves it unchanged', async t => {
  const { call, workspace } = await guarded(t)
  const file = join(workspace, 'utf16le.txt')
  const initial = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('alpha\nbeta\n', 'utf16le')])
  await writeFile(file, initial)

  await assert.rejects(call('Read', { file_path: file }), /binary file/iu)
  await assert.rejects(call('Write', { file_path: file, content: 'fresh\n' }), /without reading|requires reading|observed/iu)
  assert.equal(await hex(file), initial.toString('hex'))
})

// A bounded Read is a successful read and still records a touch, but it must
// not authorize a mutation: the guard only observes a full view (offset 0 to
// EOF), and a confirmed-missing target is observed as absent so creation stays
// guarded rather than blocked.
await test('a partial Read does not authorize an Edit or an existing-file Write', async t => {
  const { call, workspace } = await guarded(t)
  const file = join(workspace, 'partial.txt')
  const initial = 'one\ntwo\nthree\n'
  await writeFile(file, initial)
  const before = Buffer.from(initial, 'utf8').toString('hex')

  // A bounded Read observes only part of the file, so it is not a full read.
  const page = await call('Read', { file_path: file, offset: 0, limit: 1 })
  assert.equal(page.numLines, 1)

  await assert.rejects(
    call('Edit', { file_path: file, old_string: 'two', new_string: 'TWO' }),
    /full|entire|read|observed/iu,
    'a partial read cannot authorize an edit',
  )
  assert.equal(await hex(file), before)

  await assert.rejects(
    call('Write', { file_path: file, content: 'one\ntwo\nTHREE\n' }),
    /full|entire|read|observed/iu,
    'a partial read cannot authorize overwriting an existing file',
  )
  assert.equal(await hex(file), before)
})

await test('an edit after an external change is refused as stale and changes nothing', async t => {
  const { call, workspace } = await guarded(t)
  const file = join(workspace, 'stale.txt')
  await writeFile(file, 'first\nsecond\n')
  await call('Read', { file_path: file })

  const changed = 'first\nsecond\nthird\n'
  await writeFile(file, changed)
  await assert.rejects(call('Edit', { file_path: file, old_string: 'second', new_string: 'SECOND' }), /changed|stale|re-read/iu)
  await assert.rejects(call('Write', { file_path: file, content: 'gone\n' }), /changed|stale|re-read/iu)
  assert.equal(await hex(file), Buffer.from(changed, 'utf8').toString('hex'))
})

await test('a sandbox-denied Edit keeps BOM and CRLF bytes intact', async t => {
  const app = await guarded(t, { sandboxMode: 'read-only', fsMode: 'sandbox' })
  const file = join(app.workspace, 'sandboxed.txt')
  await writeFile(file, CRLF_BOM)
  const before = Buffer.from(CRLF_BOM, 'utf8').toString('hex')

  // Under read-only the filesystem backend denies every mutation, and the
  // observation policy is satisfied because the Agent did read the file.
  await app.call('Read', { file_path: file })
  await assert.rejects(
    app.call('Edit', { file_path: file, old_string: 'beta', new_string: 'BETA' }),
    /sandbox|read-only|denied/iu,
  )
  assert.equal(await hex(file), before)
})

await test('a denied edit through the executor leaves BOM and CRLF bytes intact', async t => {
  const app = await guarded(t)
  const file = join(app.workspace, 'denied.txt')
  await writeFile(file, CRLF_BOM)
  await app.call('Read', { file_path: file })

  // A guard is the executor-level denial seam: it runs after pre-execute and
  // before dispatch, exactly where a permission rule denies a call.
  const removeGuard = app.host.tools.guard((exec: { name: string }) => exec.name === 'Edit' ? 'Edit is denied by policy' : undefined)
  t.after(() => removeGuard())

  const result = await app.host.tools.execute({
    calls: [{ type: 'tool-call', id: 'denied-edit', name: 'Edit', arguments: JSON.stringify({ file_path: file, old_string: 'beta', new_string: 'BETA' }) }],
    signal: new AbortController().signal,
    agent: app.agent,
    log: { turn: 1, step: 1 },
  })
  assert.equal(result.results.length, 1)
  assert.equal(result.results[0].result.isError ?? false, true, 'the denial reaches the model as an error result')
  assert.match(JSON.stringify(result.results[0].result), /denied by policy/u)
  assert.equal(await hex(file), Buffer.from(CRLF_BOM, 'utf8').toString('hex'))
})
