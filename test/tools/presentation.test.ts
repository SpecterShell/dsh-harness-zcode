/**
 * Prove the persisted tool-card metadata contract for the ZCode tools.
 *
 * The host projects `output.presentationMeta` from the canonical value after
 * every successful call. That JSON is persisted on `tool/result` and replayed
 * by a client card, so it must stay lossless, bounded, deterministic, and out
 * of the model-facing schema and rendered text. The tests drive the real
 * executor and assert the projection against the same canonical value.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { PRESENTATION_META_MAX_BYTES } from '../../src/tools/index.ts'
import { toolHost } from '../fixtures/tool-host.ts'

const CORE = ['Bash', 'Edit', 'Read', 'Write'] as const
const SEARCH = ['Glob', 'Grep'] as const
const TOOLS = [...CORE, ...SEARCH]

/** Model-facing parameter names each tool ships. Canonical-only fields must not appear here. */
const PARAMETERS: Record<(typeof TOOLS)[number], string[]> = {
  Bash: ['command', 'description', 'timeout'],
  Edit: ['file_path', 'new_string', 'old_string', 'replace_all'],
  Glob: ['path', 'pattern'],
  Grep: ['-i', 'glob', 'head_limit', 'offset', 'output_mode', 'path', 'pattern'],
  Read: ['file_path', 'limit', 'offset'],
  Write: ['content', 'file_path'],
}

/** Serialized UTF-8 size, the unit the metadata budget is expressed in. */
function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value))
}

/** Detach one JSON value so assertions cannot pass through a shared reference. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** Freeze a cloned value, matching the executor's immutable projection inputs. */
function freezeDeep<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child)
    Object.freeze(value)
  }
  return value
}

/**
 * Compose the real tool row and expose one executor-bound call helper plus the
 * direct projection/render entry points a replay consumer would use.
 */
async function compose(
  t: Parameters<typeof toolHost>[0],
  options: Parameters<typeof toolHost>[1] = {},
) {
  const fixture = await toolHost(t, options)
  let sequence = 0

  /** Resolve one step admission so conditional Glob/Grep can execute. */
  const call = async (name: string, input: Record<string, unknown>) => {
    const signal = new AbortController().signal
    const toolSet = await fixture.host.tools.resolve({ agent: fixture.agent, modelSelection: {}, signal })
    try {
      const batch = await fixture.host.tools.execute({
        calls: [{
          type: 'tool-call',
          id: `presentation-${++sequence}`,
          name,
          arguments: JSON.stringify(input),
        }],
        agent: fixture.agent,
        toolSet,
        signal,
      })
      return batch.results[0]!.result as any
    } finally {
      toolSet.dispose()
    }
  }

  const definition = (name: string): any => {
    const value = fixture.host.tools.get(name, fixture.agent)
    assert.ok(value, `${name} is registered`)
    return value
  }

  /** Project one canonical value the way the replay path would, from detached inputs. */
  const project = (name: string, input: Record<string, unknown>, result: any): any => {
    const projector = definition(name).output.presentationMeta
    assert.equal(typeof projector, 'function', `${name} declares output.presentationMeta`)
    return clone(projector!(freezeDeep(clone(input)), freezeDeep(clone(result.value))))
  }

  /** Rendering is model-facing and must not know that metadata exists. */
  const assertRender = (name: string, input: Record<string, unknown>, result: any): void => {
    assert.deepEqual(
      result.content,
      definition(name).output.render(freezeDeep(clone(input)), freezeDeep(clone(result.value))),
      `${name} renders the same model-facing content`,
    )
  }

  return {
    host: fixture.host,
    agent: fixture.agent,
    workspace: fixture.workspace,
    call,
    definition,
    project,
    assertRender,
  }
}

await test('all six tools register card metadata without widening the model-facing schema', async t => {
  const scope = await compose(t, { searchMode: 'tools' })
  assert.equal(PRESENTATION_META_MAX_BYTES, 64 * 1024, 'the persisted card budget is part of the contract')
  const schemas = scope.host.tools.schemas(scope.agent)
  assert.deepEqual(schemas.map((schema: any) => schema.name).sort(), [...TOOLS].sort())

  for (const schema of schemas as any[]) {
    assert.deepEqual(Object.keys(schema), ['name', 'description', 'parameters'])
    assert.deepEqual(Object.keys(schema.parameters.properties).sort(), PARAMETERS[schema.name as (typeof TOOLS)[number]])
    assert.equal(schema.parameters.type, 'object')
    for (const canonicalOnly of ['cwd', 'totalFiles', 'updatedFile']) {
      assert.equal(schema.parameters.properties[canonicalOnly], undefined, `${canonicalOnly} stays out of ${schema.name} parameters`)
    }
    const tool = scope.definition(schema.name)
    assert.equal(typeof tool.output.presentationMeta, 'function')
    // This change is metadata-only: the model-facing render path is unchanged.
    assert.equal(tool.presentCall, undefined, 'no pending-card presenter is registered')
    assert.equal(tool.presentResult, undefined, 'no completed-card presenter is registered')
  }
})

await test('the executor persists the projected metadata on tool/result for replay', async t => {
  const fixture = await toolHost(t)
  const file = join(fixture.workspace, 'persisted.txt')
  await writeFile(file, 'alpha\nbeta\n')

  const signal = new AbortController().signal
  const toolSet = await fixture.host.tools.resolve({ agent: fixture.agent, modelSelection: {}, signal })
  try {
    const batch = await fixture.host.tools.execute({
      calls: [
        {
          type: 'tool-call',
          id: 'persist-read',
          name: 'Read',
          arguments: JSON.stringify({ file_path: file }),
        },
        {
          type: 'tool-call',
          id: 'persist-bash',
          name: 'Bash',
          arguments: JSON.stringify({ command: 'pwd' }),
        },
      ],
      agent: fixture.agent,
      toolSet,
      signal,
      log: { turn: 1, step: 1 },
    })

    const events = (fixture.session.log as any[]).filter(event => event.type === 'tool/result')
    assert.equal(events.length, 2)
    const byCall = new Map(events.map(event => [event.data.message.toolCallId, event]))
    for (const { callId, result } of batch.results as any[]) {
      const event = byCall.get(callId)
      assert.ok(event, `${callId} produced a tool/result event`)
      assert.deepEqual(event.data.meta, result.meta, 'the session persists exactly the projected metadata')
      assert.deepEqual(event.data.message.content, result.content, 'the persisted content is the model-facing render')
      assert.equal(event.data.message.isError, false)
      assert.equal(Object.hasOwn(event.data, 'value'), false, 'the canonical value never reaches the session log')
    }
    assert.equal(byCall.get('persist-read').data.meta.offset, 1)
    assert.equal(byCall.get('persist-bash').data.meta.cwd, fixture.workspace)
  } finally {
    toolSet.dispose()
  }
})

await test('Read metadata carries the 1-based window and keeps CRLF out of the card', async t => {
  const scope = await compose(t)
  const file = join(scope.workspace, 'window.txt')
  await writeFile(file, 'one\r\ntwo\r\nthree\r\nfour')

  const input = { file_path: file, offset: 1, limit: 2 }
  const read = await scope.call('Read', input)
  assert.equal(read.isError, false)
  assert.equal(read.value.content, '2\ttwo\n3\tthree')
  assert.deepEqual(read.meta, {
    path: file,
    offset: 2,
    lines: [
      { number: 2, text: 'two' },
      { number: 3, text: 'three' },
    ],
    totalLines: 4,
  })

  // The card's line text is LF-normalized even when the file is CRLF.
  assert.doesNotMatch(JSON.stringify(read.meta), /\r/u)
  assert.deepEqual(read.meta, scope.project('Read', input, read))
  assert.deepEqual(JSON.parse(JSON.stringify(read.meta)), read.meta, 'metadata is lossless JSON')
  scope.assertRender('Read', input, read)
})

await test('Read metadata falls back to generic when the window exceeds the metadata budget', async t => {
  const scope = await compose(t)
  const file = join(scope.workspace, 'wide.txt')
  const body = Array.from({ length: 1_000 }, (_, index) => `${String(index).padStart(4, '0')}-${'x'.repeat(190)}`)
  await writeFile(file, body.join('\n'))

  const read = await scope.call('Read', { file_path: file })
  assert.equal(read.value.numLines, 1_000)
  assert.deepEqual(read.meta, {}, 'an oversized card declines to a generic presentation')
  assert.ok(jsonBytes(read.meta) <= PRESENTATION_META_MAX_BYTES)
  // Only the card is bounded; the model-facing result is untouched.
  assert.equal((read.content[0] as any).text, read.value.content)
  scope.assertRender('Read', { file_path: file }, read)
})

await test('Write metadata projects create, applied update, no-op and capped creates', async t => {
  const scope = await compose(t)
  const file = join(scope.workspace, 'write.txt')

  const createInput = { file_path: file, content: 'one\ntwo\n' }
  const created = await scope.call('Write', createInput)
  assert.equal(created.value.type, 'create')
  assert.deepEqual(created.meta, {
    operation: 'create',
    path: file,
    diffs: [{ path: file, oldText: null, newText: 'one\ntwo\n' }],
  })
  assert.deepEqual(created.content, [{
    type: 'text',
    text: `File created successfully at: ${file} (file state is current in your context — no need to Read it back)`,
  }])
  assert.deepEqual(created.meta, scope.project('Write', createInput, created))
  scope.assertRender('Write', createInput, created)

  // The observation row requires a full Read before an overwrite.
  await scope.call('Read', { file_path: file })
  const updateInput = { file_path: file, content: 'one\nTWO\nthree\n' }
  const updated = await scope.call('Write', updateInput)
  assert.equal(updated.value.type, 'update')
  assert.deepEqual(updated.meta, {
    operation: 'update',
    path: file,
    diffs: [{ path: file, oldText: 'one\ntwo', newText: 'one\nTWO\nthree' }],
  })
  assert.deepEqual(updated.content, [{
    type: 'text',
    text: `The file ${file} has been updated successfully. (file state is current in your context — no need to Read it back)`,
  }])
  assert.doesNotMatch(JSON.stringify(updated.meta), /\r/u)
  scope.assertRender('Write', updateInput, updated)

  // An identical overwrite has no applied hunks and is not invented as a diff.
  await scope.call('Read', { file_path: file })
  const noop = await scope.call('Write', { file_path: file, content: 'one\nTWO\nthree\n' })
  assert.deepEqual(noop.meta, { operation: 'update', path: file, diffs: [] })

  // A create too large to persist as a whole-file diff declines to a generic card.
  const huge = join(scope.workspace, 'huge.txt')
  const hugeInput = { file_path: huge, content: 'x'.repeat(70_000) }
  const capped = await scope.call('Write', hugeInput)
  assert.deepEqual(capped.meta, {})
  assert.ok(jsonBytes(capped.meta) <= PRESENTATION_META_MAX_BYTES)
  assert.equal(await readFile(huge, 'utf8'), hugeInput.content, 'the canonical write is unaffected')
})

await test('Edit metadata is the literal applied hunk, preserves CRLF bytes, and refuses ambiguity', async t => {
  const scope = await compose(t)
  const file = join(scope.workspace, 'edit.txt')
  await writeFile(file, 'alpha\r\nbeta\r\ngamma\r\n')

  await scope.call('Read', { file_path: file })
  const editInput = { file_path: file, old_string: 'beta', new_string: 'BETA' }
  const edited = await scope.call('Edit', editInput)
  assert.equal(edited.value.originalFile, 'alpha\nbeta\ngamma\n', 'the canonical before image is the LF diff basis')
  assert.deepEqual(edited.value.diffs, [{
    path: file,
    oldText: 'alpha\nbeta\ngamma',
    newText: 'alpha\nBETA\ngamma',
  }], 'the canonical result carries the applied hunks')
  assert.deepEqual(edited.meta, {
    path: file,
    diffs: edited.value.diffs,
  })
  assert.equal(
    await readFile(file, 'utf8'),
    'alpha\r\nBETA\r\ngamma\r\n',
    'the card never changes the stored line endings',
  )
  assert.deepEqual(edited.content, [{ type: 'text', text: `The file ${file} has been updated successfully.` }])
  assert.doesNotMatch(JSON.stringify(edited.meta), /\r/u)
  scope.assertRender('Edit', editInput, edited)

  // A dot in old_string is literal text, not a regular expression.
  const literal = join(scope.workspace, 'literal.txt')
  await writeFile(literal, 'a.b\naXb\n')
  await scope.call('Read', { file_path: literal })
  const allInput = { file_path: literal, old_string: 'a.b', new_string: 'X.Y', replace_all: true }
  const replaced = await scope.call('Edit', allInput)
  assert.equal(await readFile(literal, 'utf8'), 'X.Y\naXb\n')
  assert.deepEqual(replaced.content, [{
    type: 'text',
    text: `The file ${literal} has been updated. All occurrences were successfully replaced.`,
  }])
  assert.deepEqual(replaced.meta, {
    path: literal,
    // Three context lines keep the unchanged neighbour in the applied hunk.
    diffs: [{ path: literal, oldText: 'a.b\naXb', newText: 'X.Y\naXb' }],
  })
  assert.deepEqual(replaced.meta, scope.project('Edit', allInput, replaced))

  // Separate applied hunks stay separate and keep their file order.
  const spread = join(scope.workspace, 'spread.txt')
  const spreadLines = ['hit', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'hit', 'z']
  await writeFile(spread, spreadLines.join('\n'))
  await scope.call('Read', { file_path: spread })
  const spreadEdit = await scope.call('Edit', {
    file_path: spread,
    old_string: 'hit',
    new_string: 'HIT',
    replace_all: true,
  })
  assert.deepEqual(spreadEdit.meta, {
    path: spread,
    diffs: [
      { path: spread, oldText: 'hit\na\nb\nc', newText: 'HIT\na\nb\nc' },
      { path: spread, oldText: 'f\ng\nh\nhit\nz', newText: 'f\ng\nh\nHIT\nz' },
    ],
  })

  // An applied diff over the metadata budget also declines to a generic card.
  const oversized = join(scope.workspace, 'oversized.txt')
  const oversizedLines = Array.from({ length: 400 }, (_, index) => `line-${index}-${'y'.repeat(180)}`)
  await writeFile(oversized, oversizedLines.join('\n'))
  await scope.call('Read', { file_path: oversized })
  const oversizedEdit = await scope.call('Edit', {
    file_path: oversized,
    old_string: oversizedLines.join('\n'),
    new_string: oversizedLines.map(line => `X${line.slice(1)}`).join('\n'),
  })
  assert.equal(oversizedEdit.isError, false)
  assert.equal(oversizedEdit.value.diffs.length, 1, 'the canonical result still carries the applied hunk')
  assert.deepEqual(oversizedEdit.meta, {})
  assert.ok(jsonBytes(oversizedEdit.meta) <= PRESENTATION_META_MAX_BYTES)

  // An ambiguous match is an error, so no card metadata is persisted.
  const ambiguous = join(scope.workspace, 'ambiguous.txt')
  await writeFile(ambiguous, 'x x\n')
  await scope.call('Read', { file_path: ambiguous })
  const failed = await scope.call('Edit', { file_path: ambiguous, old_string: 'x', new_string: 'y' })
  assert.equal(failed.isError, true)
  assert.equal(Object.hasOwn(failed, 'meta'), false)
  assert.equal(await readFile(ambiguous, 'utf8'), 'x x\n')
})

await test('Bash metadata carries the call-time cwd and exit status across outcomes', async t => {
  const scope = await compose(t)
  await mkdir(join(scope.workspace, 'sub'))

  const moved = await scope.call('Bash', { command: 'cd sub' })
  assert.equal(moved.value.status, 'completed')
  assert.equal(moved.value.cwd, scope.workspace)
  assert.deepEqual(moved.meta, {
    cwd: scope.workspace,
    status: 'completed',
    exitCode: 0,
    signal: null,
    interrupted: false,
  }, 'the terminal card is headed by the call-time directory and carries the exit status')

  const next = await scope.call('Bash', { command: 'pwd' })
  assert.equal(next.value.stdout, `${join(scope.workspace, 'sub')}\n`)
  assert.deepEqual(next.meta, {
    cwd: join(scope.workspace, 'sub'),
    status: 'completed',
    exitCode: 0,
    signal: null,
    interrupted: false,
  })
  assert.deepEqual(next.meta, scope.project('Bash', { command: 'pwd' }, next))

  const failed = await scope.call('Bash', { command: 'printf out; printf err >&2; exit 3' })
  assert.equal(failed.value.status, 'failed')
  assert.equal(failed.value.exitCode, 3)
  assert.deepEqual(failed.meta, {
    cwd: join(scope.workspace, 'sub'),
    status: 'failed',
    exitCode: 3,
    signal: null,
    interrupted: false,
  })
  assert.deepEqual(
    Object.keys(failed.meta).sort(),
    ['cwd', 'exitCode', 'interrupted', 'signal', 'status'],
    'stdout and stderr never enter the persisted card',
  )
  assert.deepEqual(failed.content, [{ type: 'text', text: 'out\nerr\n[exit code: 3]' }])
  scope.assertRender('Bash', { command: 'printf out; printf err >&2; exit 3' }, failed)

  const cancelled = await scope.call('Bash', { command: 'sleep 5', timeout: 100 })
  assert.equal(cancelled.value.status, 'cancelled')
  assert.equal(cancelled.value.exitCode, null)
  assert.equal(cancelled.value.interrupted, true)
  assert.deepEqual(cancelled.meta, {
    cwd: join(scope.workspace, 'sub'),
    status: 'cancelled',
    exitCode: null,
    signal: cancelled.value.signal,
    interrupted: true,
  })
  assert.ok(typeof cancelled.meta.signal === 'string' || cancelled.meta.signal === null)
  assert.doesNotMatch(JSON.stringify(cancelled.meta), /__ZCODE_CWD__/u)
  assert.match((cancelled.content[0] as any).text, /\[exit code: signal\]$/u)
})

await test('Glob metadata reports the capped page and the truthful pre-page total', async t => {
  const scope = await compose(t, { searchMode: 'tools' })
  await Promise.all(Array.from({ length: 105 }, (_, index) =>
    writeFile(join(scope.workspace, `file-${String(index).padStart(3, '0')}.txt`), `${index}\n`)))

  const input = { pattern: '*.txt' }
  const found = await scope.call('Glob', input)
  assert.equal(found.isError, false, found.content[0]?.text)
  assert.equal(found.value.totalFiles, 105)
  assert.equal(found.value.filenames.length, 100)
  assert.deepEqual(found.meta, {
    shape: 'paths',
    paths: found.value.filenames,
    truncated: true,
    total: 105,
  })
  assert.deepEqual(found.content, [{ type: 'text', text: found.value.filenames.join('\n') }])
  assert.ok(found.meta.paths.every((path: string) => !isAbsolute(path)), 'card paths stay in the model-facing spelling')
  assert.doesNotMatch(JSON.stringify(found.meta), /totalFiles/u)
  assert.deepEqual(found.meta, scope.project('Glob', input, found))
  scope.assertRender('Glob', input, found)

  const empty = await scope.call('Glob', { pattern: '*.nope' })
  assert.deepEqual(empty.meta, { shape: 'paths', paths: [], truncated: false, total: 0 })
  assert.deepEqual(empty.content, [{ type: 'text', text: 'No files found' }])
})

await test('Grep metadata groups the rendered page and keeps totals and truncation honest', async t => {
  const scope = await compose(t, { searchMode: 'tools' })
  await mkdir(join(scope.workspace, 'sub'), { recursive: true })
  await writeFile(join(scope.workspace, 'sub', 'a.txt'), 'needle one\nhay\nneedle two\n')
  await writeFile(join(scope.workspace, 'c.txt'), 'needle\n')
  await writeFile(join(scope.workspace, 'a:1:b.txt'), 'needle three\n')
  await writeFile(join(scope.workspace, 'd.txt'), 'hay\n')

  const paths = await scope.call('Grep', { pattern: 'needle', output_mode: 'files_with_matches' })
  assert.equal(paths.isError, false, paths.content[0]?.text)
  assert.deepEqual({
    ...paths.meta,
    files: [...paths.meta.files].sort((left: any, right: any) => left.path.localeCompare(right.path)),
  }, {
    shape: 'matches',
    files: [
      { path: 'a:1:b.txt', matches: [] },
      { path: 'c.txt', matches: [] },
      { path: 'sub/a.txt', matches: [] },
    ],
    truncated: false,
    total: 3,
  })
  assert.deepEqual(
    (paths.content[0] as any).text.split('\n').sort(),
    ['a:1:b.txt', 'c.txt', 'sub/a.txt'],
  )
  scope.assertRender('Grep', { pattern: 'needle', output_mode: 'files_with_matches' }, paths)

  const content = await scope.call('Grep', { pattern: 'needle', output_mode: 'content' })
  assert.equal(content.meta.truncated, false)
  assert.equal(content.meta.total, 4, 'total counts every match, not every file')
  // Card paths use the model-facing workdir-relative spelling in every mode.
  const byPath = new Map((content.meta.files as any[]).map(file => [file.path, file]))
  const a = byPath.get('sub/a.txt')
  const c = byPath.get('c.txt')
  const colon = byPath.get('a:1:b.txt')
  assert.ok(a, 'the grouped card contains sub/a.txt')
  assert.ok(c, 'the grouped card contains c.txt')
  assert.ok(colon, 'a path containing ":<digits>:" survives the grouping')
  assert.deepEqual(a.matches, [
    { lineNumber: 1, line: 'needle one' },
    { lineNumber: 3, line: 'needle two' },
  ])
  assert.deepEqual(c.matches, [{ lineNumber: 1, line: 'needle' }])
  assert.deepEqual(colon.matches, [{ lineNumber: 1, line: 'needle three' }])
  // The structured card is built from an unambiguous NUL-delimited capture, but
  // the canonical text a program receives keeps its model-facing colon spelling.
  assert.doesNotMatch(content.value.content as string, /\0/u)
  assert.equal((content.content[0] as any).text, content.value.content)
  assert.deepEqual(content.meta, scope.project('Grep', { pattern: 'needle', output_mode: 'content' }, content))

  const count = await scope.call('Grep', { pattern: 'needle', output_mode: 'count' })
  // Count mode has no line data, so it declines to the generic raw-output card
  // instead of reporting a file count as a match total.
  assert.deepEqual(count.meta, {})

  // Paging keeps the score of everything the search found before the page.
  const page = await scope.call('Grep', { pattern: 'needle', output_mode: 'content', head_limit: 1 })
  assert.equal(page.meta.total, 4)
  assert.equal(page.meta.truncated, true)
  assert.equal(page.meta.files.length, 1)
  assert.equal(page.meta.files[0].matches.length, 1)
  assert.equal(page.meta.files[0].matches[0].lineNumber, 1)
  assert.match(page.meta.files[0].matches[0].line, /^needle/u)

  const none = await scope.call('Grep', { pattern: 'zzz' })
  assert.deepEqual(none.meta, { shape: 'matches', files: [], truncated: false, total: 0 })
})

await test('Grep metadata is bounded while the model-facing page is untouched', async t => {
  const scope = await compose(t, { searchMode: 'tools' })
  const file = join(scope.workspace, 'wide.txt')
  await writeFile(file, Array.from({ length: 120 }, (_, index) => `needle-${index}-${'x'.repeat(600)}`).join('\n'))

  const found = await scope.call('Grep', { pattern: 'needle', output_mode: 'content' })
  assert.equal(found.isError, false, found.content[0]?.text)
  assert.equal(found.value.numMatches, 120)
  assert.equal(found.meta.total, 120)
  assert.equal(found.meta.truncated, true, 'dropping card entries is reported as truncation')
  assert.ok(jsonBytes(found.meta) <= PRESENTATION_META_MAX_BYTES)
  assert.ok(found.meta.files.length > 0, 'the card keeps a useful prefix')
  const numbers = (found.meta.files[0].matches as any[]).map(match => match.lineNumber)
  assert.deepEqual(numbers, Array.from({ length: numbers.length }, (_, index) => index + 1), 'retained matches stay in order')
  assert.match((found.content[0] as any).text, /^.*wide\.txt:1:needle-0-/u)
  scope.assertRender('Grep', { pattern: 'needle', output_mode: 'content' }, found)
})

await test('a failed call persists no card metadata and renders the same error text', async t => {
  const scope = await compose(t, { searchMode: 'tools' })
  const existing = join(scope.workspace, 'existing.txt')
  await writeFile(existing, 'alpha\n')

  const failures: Array<[string, Record<string, unknown>]> = [
    ['Read', { file_path: join(scope.workspace, 'absent.txt') }],
    ['Read', { file_path: '' }],
    ['Write', { file_path: existing, content: 'replaced\n' }],
    ['Edit', { file_path: existing, old_string: '', new_string: 'x' }],
    ['Bash', { command: '   ' }],
    ['Grep', { pattern: 'alpha', path: join(scope.workspace, 'missing') }],
  ]

  for (const [name, input] of failures) {
    const result = await scope.call(name, input)
    assert.equal(result.isError, true, `${name} fails for ${JSON.stringify(input)}`)
    assert.equal(Object.hasOwn(result, 'meta'), false, `${name} persists no partial card metadata`)
    assert.equal((result.content[0] as any).type, 'text')
    assert.match((result.content[0] as any).text, /^Error: /u)
  }
  assert.equal(await readFile(existing, 'utf8'), 'alpha\n', 'failed mutations changed nothing')
})
