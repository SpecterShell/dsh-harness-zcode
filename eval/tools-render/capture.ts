/**
 * Capture demo inputs and the exact model-visible output for every registered
 * ZCode tool, driven through the real executor (`ctx.tools.execute`), which is
 * the pipeline that renders `output.render(...)` into the tool result the model
 * reads. Denials and errors are captured as the executor materializes them.
 *
 * Run: `node --test --test-concurrency=1 --test-timeout=120000 eval/tools-render/capture.ts`
 * Output: `eval/tools-render/render.json`
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { toolHost } from '../../test/fixtures/tool-host.ts'

interface Capture {
  tool: string
  case: string
  setup: string
  args: Record<string, unknown>
  isError: boolean
  output: string
}

await test('capture every tool through the executor', { timeout: 120_000 }, async t => {
  const app = await toolHost(t, { searchMode: 'tools' })
  const demo = join(app.workspace, 'demo')
  await mkdir(join(demo, 'nested'), { recursive: true })
  // Search fixtures exist before the Bash cases so the prelude can find them.
  await writeFile(join(demo, 'nested', 'find-me.ts'), 'export const needle = 1\n')
  await writeFile(join(demo, 'nested', 'other.ts'), 'nothing here\n')
  const rows: Capture[] = []
  let seq = 0
  // Conditional rows (Glob, Grep) are admitted only through a resolved step.
  const signal = new AbortController().signal
  const toolSet = await app.host.tools.resolve({ agent: app.agent, modelSelection: {}, signal })

  /** Run one call through the executor and record the model-visible text. */
  const run = async (tool: string, label: string, args: Record<string, unknown>, setup: string): Promise<Capture> => {
    const result = await app.host.tools.execute({
      calls: [{ type: 'tool-call', id: `capture-${++seq}`, name: tool, arguments: JSON.stringify(args) }],
      signal,
      agent: app.agent,
      toolSet,
      log: { turn: 1, step: 1 },
      maxParallelToolCalls: 1,
    })
    const outcome = result.results[0]
    assert.ok(outcome, `${tool} produced one result`)
    const output = (outcome.result.content ?? [])
      .map((block: { type: string; text?: string }) => block.text ?? `[${block.type}]`)
      .join('')
    const row: Capture = { tool, case: label, setup, args, isError: outcome.result.isError === true, output }
    rows.push(row)
    return row
  }

  /** Seed a file directly, outside the tool surface. */
  const seed = async (name: string, content: string): Promise<string> => {
    const path = join(demo, name)
    await writeFile(path, content)
    return path
  }

  // Read
  const basic = await seed('hello.txt', 'alpha\nbeta\ngamma\n')
  await run('Read', 'basic read with line numbers', { file_path: basic }, 'file holds "alpha\\nbeta\\ngamma\\n"')
  await run('Read', 'offset and limit', { file_path: basic, offset: 1, limit: 1 }, 'same file, offset 1 limit 1')
  const long = await seed('long.txt', Array.from({ length: 2100 }, (_, index) => `line-${index}`).join('\n') + '\n')
  await run('Read', 'truncated at the default line budget', { file_path: long }, 'file holds 2100 lines')
  const bom = await seed('bom.txt', '\uFEFFalpha\r\nbeta\r\n')
  await run('Read', 'BOM file, BOM does not reach the model', { file_path: bom }, 'file starts with a UTF-8 BOM and uses CRLF')
  const empty = await seed('empty.txt', '')
  await run('Read', 'empty file', { file_path: empty }, 'zero-byte file')
  await run('Read', 'missing file', { file_path: join(demo, 'absent.txt') }, 'path does not exist')

  // Write
  const created = join(demo, 'created.txt')
  await run('Write', 'create', { file_path: created, content: 'first\nsecond\n' }, 'target does not exist')
  await run('Read', 'read before overwrite', { file_path: created }, 'read the file the next case overwrites')
  await run('Write', 'overwrite existing', { file_path: created, content: 'first\nSECOND\n' }, 'target exists and was just read')

  // Edit
  await run('Read', 'read before edit', { file_path: basic }, 'read the file the edit rewrites')
  await run('Edit', 'unique replacement', { file_path: basic, old_string: 'beta', new_string: 'BETA' }, 'file read directly before this call')
  const repeat = await seed('repeat.txt', 'same\nsame\n')
  await run('Read', 'read before replace_all', { file_path: repeat }, 'file holds "same\\nsame\\n"')
  await run('Edit', 'replace_all', { file_path: repeat, old_string: 'same', new_string: 'twice', replace_all: true }, 'same file, replace_all true')
  const ambiguous = await seed('ambiguous.txt', 'same\nsame\n')
  await run('Read', 'read ambiguous file', { file_path: ambiguous }, 'file holds two identical lines')
  await run('Edit', 'ambiguous match refused', { file_path: ambiguous, old_string: 'same', new_string: 'once' }, 'two matches, replace_all omitted')
  const unread = await seed('unread.txt', 'body\n')
  await run('Edit', 'edit without a prior read refused', { file_path: unread, old_string: 'body', new_string: 'other' }, 'file never read in this session')
  const stale = await seed('stale.txt', 'before\n')
  await run('Read', 'read before external change', { file_path: stale }, 'read, then the next case rewrites the file outside the tool')
  await writeFile(stale, 'before\nexternal\n')
  await run('Edit', 'stale after external change refused', { file_path: stale, old_string: 'before', new_string: 'after' }, 'file changed on disk after the read')
  const encoding = await seed('encoding.txt', '\uFEFFalpha\r\nbeta\r\n')
  await run('Read', 'read BOM+CRLF file before edit', { file_path: encoding }, 'file starts with a UTF-8 BOM and uses CRLF')
  const edited = await run('Edit', 'BOM/CRLF file after a successful edit', { file_path: encoding, old_string: 'beta', new_string: 'BETA' }, 'edit a BOM+CRLF file after a full read')
  edited.setup += ` | resulting bytes: ${(await readFile(encoding)).toString('hex')}`

  // Bash
  await run('Bash', 'simple command', { command: 'printf "hello\\n"' }, 'no prior state, cwd is the workspace')
  await run('Bash', 'search prelude: grep and find available', { command: 'grep -n needle demo/nested/find-me.ts; find demo -name "*.ts" | head -2' }, 'searchMode bash; prelude defines grep and find')
  await run('Bash', 'cwd persistence, step 1', { command: 'cd demo && pwd' }, 'workspace root, cd into demo')
  await run('Bash', 'cwd persistence, step 2', { command: 'pwd' }, 'immediately after the previous call')
  await run('Bash', 'non-zero exit with stderr', { command: 'printf "out\\n"; printf "err\\n" >&2; exit 3' }, 'command exits 3')
  await run('Bash', 'timeout cancelled', { command: 'sleep 5', timeout: 100 }, 'timeout 100 ms while sleeping')
  await run('Bash', 'truncated output recovers cwd, step 1', { command: 'for i in $(seq 1 4000); do printf "line-%s-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\\n" "$i"; done; cd demo' }, 'emits more than the capture budget then cds')
  await run('Bash', 'truncated output recovers cwd, step 2', { command: 'pwd' }, 'immediately after the truncated call')

  // Glob
  await run('Glob', 'pattern match', { pattern: '**/*.ts', path: demo }, 'two .ts files under demo/nested')
  const many = join(demo, 'many')
  await mkdir(many, { recursive: true })
  await Promise.all(Array.from({ length: 120 }, (_, index) => writeFile(join(many, `file-${index}.md`), `${index}\n`)))
  await run('Glob', 'truncated at 100 results', { pattern: '*.md', path: many }, '120 .md files in demo/many')

  // Grep
  await run('Grep', 'content match', { pattern: 'needle', path: demo, output_mode: 'content' }, 'one file contains "needle"')
  await run('Grep', 'glob filter', { pattern: 'needle', path: demo, glob: '*.ts' }, 'same match, restricted to .ts')

  await writeFile(join(import.meta.dirname, 'render.json'), JSON.stringify(rows, null, 2))
  t.diagnostic(JSON.stringify({ captured: rows.length, tools: [...new Set(rows.map(row => row.tool))] }))
})
