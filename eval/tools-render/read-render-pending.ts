/**
 * Reproduction for the future Read render fix. NOT part of the default gate:
 * run it explicitly with
 * `node --test --test-concurrency=1 eval/tools-render/read-render-pending.ts`.
 * The two cases are todo, so this file documents the pending contract without
 * turning `pnpm test` red for a defect that has no authorized fix yet.
 *
 * Tools' ruled contract: a terminal newline must not add a synthetic numbered
 * line, and a truly empty file renders the empty-file warning. Both cases are
 * `todo` until the fix lands, so the gate stays informative instead of red for
 * a known defect; they turn into hard assertions the moment the source changes.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { toolHost } from '../../test/fixtures/tool-host.ts'

/** Execute one Read and return the rendered model-facing text. */
async function renderRead(app: Awaited<ReturnType<typeof toolHost>>, args: Record<string, unknown>): Promise<string> {
  const tool = app.host.tools.get('Read', app.agent) as {
    execute: (args: unknown, exec: unknown) => Promise<unknown>
    output: { render: (args: unknown, value: unknown) => { text: string }[] }
  }
  const value = await tool.execute(args, {
    callId: 'render-read',
    name: 'Read',
    arguments: args,
    signal: new AbortController().signal,
    agent: app.agent,
  })
  return tool.output.render(args, value).map(block => block.text).join('')
}

await test('a terminal newline adds no synthetic numbered line', { todo: 'terminal-newline render fix pending' }, async t => {
  const app = await toolHost(t)
  const lf = join(app.workspace, 'terminal-lf.txt')
  const crlf = join(app.workspace, 'terminal-crlf.txt')
  await writeFile(lf, 'alpha\nbeta\n')
  await writeFile(crlf, 'alpha\r\nbeta\r\n')

  assert.equal(await renderRead(app, { file_path: lf }), '1\talpha\n2\tbeta')
  assert.equal(await renderRead(app, { file_path: crlf }), '1\talpha\n2\tbeta')
})

await test('an empty file renders the empty-file warning', { todo: 'empty-file render fix pending' }, async t => {
  const app = await toolHost(t)
  const empty = join(app.workspace, 'empty.txt')
  await writeFile(empty, '')

  // Upstream's literal is wrapped is a system reminder: `formatReadToolResultWarning`
  // in core/src/tool/handlers/read-text.ts:123-125 wraps the body in
  // <system-reminder>…</system-reminder>. Pin the wrapper for exact parity.
  assert.equal(
    await renderRead(app, { file_path: empty }),
    '<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>',
  )
})
