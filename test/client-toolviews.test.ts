/**
 * Prove the built client bundle registers the six uppercase ZCode tool views
 * and renders the native cards from result metadata, with explicit fallbacks
 * for older logs that carry no metadata.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { loadClientModule } from './fixtures/client-module.ts'
import type { ClientModule } from './fixtures/client-module.ts'

interface VNode {
  type: unknown
  props: Record<string, any>
}

const TOOLS = ['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write']

function element(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): VNode {
  return {
    type,
    props: {
      ...(props ?? {}),
      ...(children.length === 0
        ? {}
        : { children: children.length === 1 ? children[0] : children }),
    },
  }
}

function nodes(root: unknown): VNode[] {
  const found: VNode[] = []
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child)
      return
    }
    if (typeof node !== 'object' || node === null || !('type' in node) || !('props' in node)) return
    const current = node as VNode
    found.push(current)
    visit(current.props.children)
    // Disclosure rows carry their summary in a prop rather than children.
    visit(current.props.collapsedContent)
  }
  visit(root)
  return found
}

/** Marker primitives keep their identity so a rendered card can be recognized. */
function marker(name: string) {
  return (props: Record<string, unknown>) => element(name, props)
}

/** Load the built bundle with the two external modules it may require. */
async function load() {
  const primitives = {
    DiffBlock: marker('diff-block'),
    DisclosureRow: marker('disclosure-row'),
    IconApiOutlineRegular: marker('icon-api'),
    IconBrowseOutlineRegular: marker('icon-browse'),
    IconEditOutlineRegular: marker('icon-edit'),
    IconInspectOutlineRegular: marker('icon-inspect'),
    IconSearchOutlineRegular: marker('icon-search'),
    ReadBlock: marker('read-block'),
    SearchBlock: marker('search-block'),
    TerminalBlock: marker('terminal-block'),
    diffTotals: (diffs: Array<{ oldText: string | null; newText: string }>) => ({
      added: diffs.length,
      removed: diffs.length,
    }),
    settingsNumberField: (name: string) => ({
      field: name,
      format: (value: unknown) => String(value ?? ''),
      parse: (text: string) => ({ kind: 'set', value: Number(text) }),
    }),
  }
  const react = {
    createElement: element,
    useSyncExternalStore: (
      _subscribe: (listener: () => void) => () => void,
      getSnapshot: () => unknown,
    ) => getSnapshot(),
  }
  const loaded = await loadClientModule(name => {
    if (name === 'react') return react
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error(`unexpected client dependency: ${name}`)
  })
  return { loaded, primitives }
}

/** Run the real entry with just enough client services to observe registration. */
function mount(loaded: ClientModule) {
  const injections: string[] = []
  const registrations: Array<{ options: Record<string, any>; factory: unknown }> = []
  const slots = {
    inject(key: string, callback: () => unknown) {
      injections.push(key)
      const result = callback()
      // The toolview mount yields one disposer per registered key.
      if (result !== null && typeof result === 'object' && Symbol.iterator in result) {
        for (const _dispose of result as Iterable<() => void>) { /* drain the registration generator */ }
      }
      return () => {}
    },
    register(options: Record<string, any>, factory: unknown) {
      registrations.push({ options, factory })
      return () => {}
    },
  }
  loaded.apply({
    effect(setup: () => unknown) {
      const dispose = setup()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    locale: {
      register: () => () => {},
      bind: (_namespace: string) => (key: string) => key,
    },
    slots,
    configForms: {
      get: () => ({}),
      whileServed: () => () => {},
    },
  })
  return { injections, registrations }
}

/** Render one completed call as the slot row would. */
function render(loaded: ClientModule, toolName: string, args: unknown, block: Record<string, unknown>): VNode[] {
  const view = loaded.ZCodeToolview as (props: Record<string, unknown>) => unknown
  return nodes(view({
    phase: 'result',
    toolName,
    block: {
      ...block,
      call: { argsRaw: JSON.stringify(args) },
    },
    useDisclosure: () => ({ expanded: true, toggle: () => {} }),
    openFile: () => {},
    t: (key: string, values?: Record<string, unknown>) =>
      values === undefined ? key : `${key}:${JSON.stringify(values)}`,
  }))
}

/** The row state the client exposes on its outer element. */
function stateOf(all: VNode[]): unknown {
  return all.find(node => typeof node.props['data-tool'] === 'string')?.props['data-state']
}

await test('the built bundle registers exactly the six uppercase toolview keys', async () => {
  const { loaded } = await load()
  const { injections, registrations } = mount(loaded)

  assert.ok(injections.includes('tool.call.toolview'))
  assert.deepEqual(registrations.map(entry => entry.options.key).sort(), TOOLS)
  for (const entry of registrations) {
    assert.equal(entry.options.name, 'tool.call.toolview')
    assert.equal(entry.options.locale, 'conversation')
    assert.equal(entry.factory, loaded.ZCodeToolview, `${entry.options.key} renders the ZCode row`)
  }
})

await test('Read, Glob and Grep display their native cards and fall back to raw text', async () => {
  const { loaded, primitives } = await load()

  const readMeta = {
    path: '/repo/notes.txt',
    offset: 3,
    lines: [{ number: 3, text: 'gamma' }, { number: 4, text: 'delta' }],
    totalLines: 9,
  }
  const read = render(loaded, 'Read', { file_path: '/repo/notes.txt' }, {
    content: [{ type: 'text', text: '3\tgamma\n4\tdelta' }],
    isError: false,
    meta: readMeta,
  })
  assert.equal(stateOf(read), 'ok')
  const readCard = read.find(node => node.type === primitives.ReadBlock)
  assert.ok(readCard, 'a valid read meta renders ReadBlock')
  assert.deepEqual(readCard.props.lines, readMeta.lines)
  assert.equal(readCard.props.label, readMeta.path)
  assert.equal(readCard.props.totalLines, readMeta.totalLines)
  assert.equal(read.some(node => node.type === 'pre'), false)

  // Older or malformed metadata declines to the raw model-facing text.
  const readFallback = render(loaded, 'Read', { file_path: '/repo/notes.txt' }, {
    content: [{ type: 'text', text: '1\talpha' }],
    isError: false,
    meta: {},
  })
  assert.equal(readFallback.some(node => node.type === primitives.ReadBlock), false)
  assert.equal(readFallback.find(node => node.type === 'pre')?.props.children, '1\talpha')

  const glob = render(loaded, 'Glob', { pattern: '*.ts' }, {
    content: [{ type: 'text', text: 'a.ts\nb.ts' }],
    isError: false,
    meta: { shape: 'paths', paths: ['a.ts', 'b.ts'], truncated: false, total: 2 },
  })
  const globCard = glob.find(node => node.type === primitives.SearchBlock)
  assert.ok(globCard, 'a paths meta renders SearchBlock')
  assert.equal(globCard.props.kind, 'paths')
  assert.deepEqual(globCard.props.paths, ['a.ts', 'b.ts'])
  assert.equal(globCard.props.truncated, false)
  assert.equal(globCard.props.total, 2)

  const grepMeta = {
    shape: 'matches',
    files: [{ path: 'a.ts', matches: [{ lineNumber: 2, line: 'needle' }] }],
    truncated: true,
    total: 3,
  }
  const grep = render(loaded, 'Grep', { pattern: 'needle' }, {
    content: [{ type: 'text', text: 'a.ts:2:needle' }],
    isError: false,
    meta: grepMeta,
  })
  const grepCard = grep.find(node => node.type === primitives.SearchBlock)
  assert.ok(grepCard, 'a matches meta renders SearchBlock')
  assert.equal(grepCard.props.kind, 'matches')
  assert.deepEqual(grepCard.props.files, grepMeta.files)
  assert.equal(grepCard.props.truncated, true)
  assert.equal(grepCard.props.total, 3)
  assert.equal(grep.some(node => node.type === 'pre'), false, 'valid search metadata does not repeat raw text')

  // Malformed search metadata still falls back to the raw page exactly once.
  const globFallback = render(loaded, 'Glob', { pattern: '*.ts' }, {
    content: [{ type: 'text', text: 'a.ts\nb.ts' }],
    isError: false,
    meta: {},
  })
  assert.equal(globFallback.some(node => node.type === primitives.SearchBlock), false)
  assert.equal(globFallback.find(node => node.type === 'pre')?.props.children, 'a.ts\nb.ts')
})

await test('Bash states and legacy failures use one verbatim fallback without metadata', async () => {
  const { loaded, primitives } = await load()

  // A historical log has no metadata and may not flag a non-zero command as an
  // error. Its final exit marker may drive state and badge only.
  const legacy = render(loaded, 'Bash', { command: 'boom' }, {
    content: [{ type: 'text', text: 'out\nerr\n[exit code: 3]' }],
    isError: false,
  })
  assert.equal(stateOf(legacy), 'error')
  assert.equal(legacy.some(node => node.type === primitives.TerminalBlock), false)
  assert.deepEqual(
    legacy.filter(node => node.type === 'pre').map(node => node.props.children),
    ['out\nerr\n[exit code: 3]'],
    'the historical result appears once, verbatim',
  )
  assert.equal(
    legacy.find(node => node.props.className === 'dsh-zcode-tool-badge')?.props.children,
    'terminal.exitCode:{"code":3}',
  )

  const cancelled = render(loaded, 'Bash', { command: 'sleep 5' }, {
    content: [{ type: 'text', text: '\n__ZCODE_CWD__/repo\n\n[exit code: signal]' }],
    isError: false,
    meta: {
      cwd: '/repo',
      status: 'cancelled',
      exitCode: null,
      signal: 'SIGTERM',
      interrupted: true,
    },
  })
  assert.equal(stateOf(cancelled), 'stopped')
  const cancelledTerminal = cancelled.find(node => node.type === primitives.TerminalBlock)
  assert.ok(cancelledTerminal)
  assert.equal(cancelledTerminal.props.cwd, '/repo')
  assert.equal(cancelledTerminal.props.exitCode, null)
  assert.equal(cancelledTerminal.props.signal, 'SIGTERM')
  assert.equal(cancelledTerminal.props.output, undefined, 'the leaked cwd marker and exit trailer are stripped')
  assert.equal(cancelled.some(node => node.type === 'pre'), false)
})

await test('mutation cards reuse the public diff totals helper', async () => {
  const { loaded, primitives } = await load()
  const write = render(loaded, 'Write', { file_path: '/repo/a.ts', content: 'b\n' }, {
    content: [{ type: 'text', text: 'The file /repo/a.ts has been updated successfully.' }],
    isError: false,
    meta: {
      operation: 'update',
      path: '/repo/a.ts',
      diffs: [{ path: '/repo/a.ts', oldText: 'a\n', newText: 'b\n' }],
    },
  })
  assert.equal(stateOf(write), 'ok')
  assert.ok(write.find(node => node.type === primitives.DiffBlock), 'a valid diff meta renders DiffBlock')
  assert.equal(write.find(node => node.props.className === 'dsh-zcode-tool-added')?.props.children, '+1')
  assert.equal(write.find(node => node.props.className === 'dsh-zcode-tool-removed')?.props.children, '-1')
})
