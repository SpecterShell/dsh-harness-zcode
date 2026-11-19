import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

interface VNode {
  type: unknown
  props: Record<string, unknown>
}

interface FieldState {
  text: string
  overridden: boolean
  invalid: boolean
}

function field(text: string, overridden = false): FieldState {
  return { text, overridden, invalid: false }
}

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

function expand(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(expand)
  if (typeof node !== 'object' || node === null || !('type' in node) || !('props' in node)) return node
  const current = node as VNode
  if (typeof current.type === 'function') {
    return expand((current.type as (props: Record<string, unknown>) => unknown)(current.props))
  }
  return {
    ...current,
    props: {
      ...current.props,
      ...('children' in current.props ? { children: expand(current.props.children) } : {}),
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
  }
  visit(root)
  return found
}

async function loadClientSettings() {
  const code = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')

  const edits: Array<[string, string]> = []
  const resets: string[] = []
  const requestedNamespaces: string[] = []
  let cardFactory: ((props: unknown) => unknown) | undefined

  const states: Record<string, FieldState> = {
    searchMode: field('tools', true),
    surfaceAllow: field('working_directory'),
    headless: field('false'),
    memoryEnabled: field('true', true),
    memoryExtractionEnabled: field('true'),
    compactionEnabled: field('true'),
    microcompactionEnabled: field('false'),
    compactionThreshold: field('0.8'),
    microcompactionThreshold: field('0.5'),
    memoryMaxBytes: field('32768'),
    workspaceMemoryRoot: field('.zcode/memory'),
  }

  class SettingsFormModel {
    bind(project: () => unknown) {
      return {
        getSnapshot: project,
        subscribe: () => () => {},
      }
    }

    shell() {
      return {
        available: true,
        writable: true,
        dirty: false,
        invalid: false,
        saving: false,
        failed: false,
      }
    }

    field(name: string): FieldState {
      const state = states[name]
      assert.ok(state, `missing fixture field ${name}`)
      return state
    }

    actions() {
      return {
        edit: (name: string, text: string) => { edits.push([name, text]) },
        resetField: (name: string) => { resets.push(name) },
        save: () => {},
        discard: () => {},
      }
    }

    dispose(): void {}
  }

  const marker = (name: string) => (props: Record<string, unknown>): VNode => element(name, props)
  const primitives = {
    SegmentedControl: marker('segmented-control'),
    SettingsForm: marker('settings-form'),
    SettingsFormModel,
    SettingsValueField: marker('settings-value-field'),
    Switch: marker('switch'),
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
  let registration: {
    factory: (require: (name: string) => unknown) => Record<string, unknown>
  } | undefined
  const require = (name: string): unknown => {
    if (name === 'react') return react
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error(`unexpected client dependency: ${name}`)
  }
  Function('window', code)({
    __ModuleLoader__: {
      load: (next: typeof registration) => { registration = next },
    },
  })
  assert.ok(registration)
  const loaded = registration.factory(require)

  const mount = loaded.mountSettingsCard
  assert.equal(typeof mount, 'function')
  ;(mount as (ctx: unknown, translate: (key: string) => string) => void)({
    effect: (setup: () => unknown) => setup(),
    configForms: {
      get: (namespace: string) => {
        requestedNamespaces.push(namespace)
        return {}
      },
      whileServed: (namespaces: readonly string[], register: (served: ReadonlySet<string>) => unknown) => {
        assert.deepEqual(namespaces, [
          '@spectershell/dsh-harness-zcode',
          'include:@spectershell/dsh-harness-zcode',
        ])
        register(new Set(['include:@spectershell/dsh-harness-zcode']))
        return () => {}
      },
    },
    slots: {
      inject: (_key: string, callback: () => unknown) => {
        callback()
        return () => {}
      },
      register: (_options: unknown, factory: (props: unknown) => unknown) => {
        cardFactory = factory
        return () => {}
      },
    },
  }, key => key)

  assert.deepEqual(requestedNamespaces, ['include:@spectershell/dsh-harness-zcode'])
  assert.ok(cardFactory)
  return { tree: expand(cardFactory({})), edits, resets }
}

test('client settings use platform switches, compact search choices, and override resets', async () => {
  const { tree, edits, resets } = await loadClientSettings()
  const all = nodes(tree)
  const switches = all.filter(node => node.type === 'switch')
  assert.deepEqual(
    switches.map(node => node.props.label),
    [
      'settings.headless',
      'settings.memoryEnabled',
      'settings.memoryExtractionEnabled',
      'settings.compactionEnabled',
      'settings.microcompactionEnabled',
    ],
  )
  assert.deepEqual(switches.map(node => node.props.checked), [false, true, true, true, false])

  ;(switches[0]!.props.onChange as (next: boolean) => void)(true)
  ;(switches[1]!.props.onChange as (next: boolean) => void)(false)
  assert.deepEqual(edits, [
    ['headless', 'true'],
    ['memoryEnabled', 'false'],
  ])

  const segmented = all.find(node => node.type === 'segmented-control')
  assert.ok(segmented)
  assert.equal(segmented.props.value, 'tools')
  assert.deepEqual(segmented.props.options, [
    { value: 'bash', label: 'settings.searchBash' },
    { value: 'tools', label: 'settings.searchTools' },
  ])
  ;(segmented.props.onChange as (next: string) => void)('bash')
  assert.deepEqual(edits.at(-1), ['searchMode', 'bash'])

  const resetButtons = all.filter(node =>
    node.type === 'button'
    && typeof node.props.className === 'string'
    && node.props.className.includes('settings-reset'))
  assert.deepEqual(
    resetButtons.map(node => node.props['aria-label']),
    [
      'settings.reset: settings.searchMode',
      'settings.reset: settings.memoryEnabled',
    ],
  )
  for (const button of resetButtons) (button.props.onClick as () => void)()
  assert.deepEqual(resets, ['searchMode', 'memoryEnabled'])

  const memoryHead = all.find(node =>
    node.type === 'div'
    && node.props.className === 'dsh-harness-zcode-settings-head'
    && JSON.stringify(node.props.children).includes('settings.memoryEnabled'))
  assert.ok(memoryHead)
  const memoryChildren = (memoryHead.props.children as unknown[]).filter(Boolean) as VNode[]
  assert.equal(memoryChildren[0]!.props.children, 'settings.memoryEnabled')
  assert.equal(memoryChildren.at(-2)!.type, 'button', 'the reset is immediately left of the switch')
  assert.equal(memoryChildren.at(-1)!.type, 'switch')

  assert.ok(all.some(node =>
    node.type === 'p'
    && node.props.children === 'settings.searchModeHint'))
})

test('search mode descriptions and reset labels are localized', async () => {
  const read = async (name: string): Promise<Record<string, string>> =>
    JSON.parse(await readFile(new URL(`../locale/${name}.json`, import.meta.url), 'utf8')) as Record<string, string>
  const [en, zh] = await Promise.all([read('en'), read('zh')])

  for (const locale of [en, zh]) {
    assert.ok(locale['settings.searchModeHint'])
    assert.ok(locale['settings.searchBash'])
    assert.ok(locale['settings.searchTools'])
    assert.ok(locale['settings.reset'])
  }
  assert.notEqual(en['settings.searchModeHint'], zh['settings.searchModeHint'])
})
