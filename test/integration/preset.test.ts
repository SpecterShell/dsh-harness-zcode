/**
 * Prove the shipped ZCode preset rows through the real patch loader, preset
 * registry, scoped tool registry, native PTC executor and the installed host
 * implementations of every row.
 */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { mount, native, temporary } from '../fixtures/native-host.ts'
import type { HostValue } from '../fixtures/native-host.ts'

const { Context } = await native('cordis')
const { Loader, Group } = await native('cordis-plugin-loader')
const { applyEntryPatches } = await native('cordis-plugin-include')
const { loadOverlayPatches } = await native('dsh-app-boot')
const { SystemPrompt } = await native('dsh-system-prompt')
const { ToolsService } = await native('dsh-tools')
const executor = await native('dsh-tool-executor-native')
const { SessionStore } = await native('dsh-session')
const { SessionProjectionRegistry } = await native('dsh-session-projection')
const { LocalFileSystem } = await native('dsh-fs-local')
const { LocalSubprocessRuntime } = await native('dsh-subprocess-local')
const { WorkingDirectoryService } = await native('dsh-working-directory')
const { TokenMeter } = await native('dsh-token-meter')
const { SandboxPolicyService } = await native('dsh-sandbox-policy')
const { LocalBashExecutor } = await native('dsh-bash-local')
const LocalSandboxProvider = (await native('dsh-sandbox-local')).default
const { AgentRegistry } = await native('dsh-agent')
const AgentPreset = await native('dsh-agent-preset')
const { AgentPresetRegistry } = await native('dsh-agent-preset-registry')
const { createScope, scopeOf } = await native('dsh-scope')
const { CommandRuntime } = await native('dsh-commands')
const timeContext = await native('dsh-time-context')
const commandCompact = await native('dsh-command-compact')
const SkillRegistry = (await native('dsh-skill')).default
const skillFilesystem = await native('dsh-skill-filesystem')
const toolSkill = await native('dsh-tool-skill')
const toolCordis = await native('dsh-tool-cordis')
const pluginManagerTools = await native('dsh-plugin-manager/tools')
const pluginMarketTools = await native('dsh-plugin-market/tools')
const { SubagentRuntime } = await native('dsh-subagent')
const subagentSpawn = await native('dsh-subagent-spawn-in-process')
const subagentFork = await native('dsh-subagent-fork-in-process')
const workflowPtc = await native('dsh-workflow-ptc')
const toolWorkflow = await native('dsh-tool-workflow')
const toolSubagentControl = await native('dsh-tool-subagent-control')
const toolSubagent = await native('dsh-tool-subagent')
const NodePtcRuntime = (await native('dsh-ptc-runtime-node')).default
const toolExecutorPtc = await native('dsh-tool-executor-ptc')

const hostRow = await import('../../src/host.ts')
const contextRow = await import('../../src/context/index.ts')
const toolsRow = await import('../../src/tools/index.ts')
const surfaceRow = await import('../../src/surface.ts')

const ZCODE_TOOLS = ['Bash', 'Edit', 'Read', 'Write']
const SEARCH_TOOLS = ['Glob', 'Grep']
const SKILL_TOOLS = ['skill']
const DELEGATION_TOOLS = [
  'list_agents',
  'list_subagent_models',
  'send_message',
  'subagent',
  'subagent_fork',
  'wait_agent',
  'workflow',
]
const INSPECT_TOOLS = ['cordis_inspect_list', 'cordis_inspect_query']

interface PresetRow {
  id?: string
  name: string
  group?: boolean
  config: HostValue
  [key: string]: unknown
}

function builtinRows(rows: PresetRow[], bindings: Map<string, string>): PresetRow[] {
  return rows.map(row => {
    if (row.group === true) {
      return { ...row, name: 'cordis:group', config: builtinRows(row.config as PresetRow[], bindings) }
    }
    const builtin = bindings.get(row.name)
    assert.ok(builtin, `no real module is bound for preset row "${row.name}"`)
    return { ...row, name: `cordis:${builtin}` }
  })
}

function hostTool(name: string) {
  return {
    name,
    description: `Inherited fixture tool ${name}.`,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: string) => [{ type: 'text', text: value }],
    },
    execute: async () => name,
  }
}

await test('the patch declares the four exact ZCode preset identities and compositions', () => {
  const patchPath = fileURLToPath(new URL('../../cordis.patch.yml', import.meta.url))
  const rows = applyEntryPatches([], loadOverlayPatches('zcode-test', patchPath))
  assert.equal(rows[0]?.id, '@spectershell/dsh-harness-zcode')
  assert.equal(rows[0]?.name, '@spectershell/dsh-harness-zcode')

  const expected = [
    ['preset-zcode-strict', 'zcode-strict', 'ZCode strict mode', 6],
    ['preset-zcode', 'zcode', 'ZCode mode', 5],
    ['preset-zcode-ptc', 'zcode-ptc', 'ZCode PTC', 7],
    ['preset-zcode-creator', 'zcode-creator', 'ZCode Creator', 8],
  ] as const
  for (const [rowId, id, name, order] of expected) {
    const row = rows.find((candidate: HostValue) => candidate.id === rowId)
    assert.ok(row, `${rowId} is present`)
    assert.equal(row.name, '@deepseek-ai/dsh-agent-preset')
    assert.equal(row.config.id, id)
    assert.equal(row.config.name, name)
    assert.equal(row.config.order, order)
    const context = row.config.plugins.find((plugin: HostValue) => plugin.id === 'context')
    assert.ok(context?.group, `${id} has an isolated context group`)
    assert.ok(context.config.some((plugin: HostValue) => plugin.name === '@spectershell/dsh-harness-zcode/context'))
    assert.ok(context.config.some((plugin: HostValue) => plugin.name === '@deepseek-ai/dsh-command-compact'))
    assert.ok(row.config.plugins.some((plugin: HostValue) => plugin.name === '@spectershell/dsh-harness-zcode/tools'))
    assert.ok(row.config.plugins.some((plugin: HostValue) => plugin.name === '@spectershell/dsh-harness-zcode/surface'))
  }

  const strict = rows.find((row: HostValue) => row.id === 'preset-zcode-strict')
  const extended = rows.find((row: HostValue) => row.id === 'preset-zcode')
  const ptc = rows.find((row: HostValue) => row.id === 'preset-zcode-ptc')
  const creator = rows.find((row: HostValue) => row.id === 'preset-zcode-creator')
  assert.deepEqual(strict.config.plugins.find((row: HostValue) => row.id === 'surface').config, {
    allow: ['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write', 'skill'],
  })
  assert.deepEqual(extended.config.plugins.find((row: HostValue) => row.id === 'surface').config.deny, [
    'read', 'write', 'edit', 'glob', 'grep', 'bash', 'pwsh',
  ])
  assert.ok(ptc.config.plugins.some((row: HostValue) => row.id === 'tool-executor-ptc'))
  assert.ok(creator.config.plugins.some((row: HostValue) => row.id === 'tool-cordis'))
  assert.ok(creator.config.plugins.some((row: HostValue) => row.id === 'tool-plugin-manager'))
  assert.ok(creator.config.plugins.some((row: HostValue) => row.id === 'tool-plugin-market'))
  assert.deepEqual(creator.config.plugins.find((row: HostValue) => row.id === 'surface').config.allow, [
    'Bash',
    'Edit',
    'Glob',
    'Grep',
    'Read',
    'Write',
    'cordis_inspect_list',
    'cordis_inspect_query',
    'plugin_manager',
    'plugin_market',
    'skill',
  ])
})

await test('the real registry mounts all scopes and enforces their inherited-tool contracts', { timeout: 60_000 }, async t => {
  const root = await temporary(t)
  const readable = join(root, 'ptc-visible.txt')
  await writeFile(readable, 'visible through nested ZCode Read\n')

  const host = new Context()
  t.after(() => host.fiber.dispose())
  const loaderFiber = host.plugin(Loader, { baseUrl: import.meta.url })
  await loaderFiber.await()
  const loader = host.loader
  loader.enableLogs = false
  loader.builtins.prompt = SystemPrompt
  loader.builtins.tools = ToolsService
  loader.builtins.executor = executor
  loader.builtins.group = Group

  const bindings = new Map([
    ['@spectershell/dsh-harness-zcode/context', 'zcode-context'],
    ['@spectershell/dsh-harness-zcode/tools', 'zcode-tools'],
    ['@spectershell/dsh-harness-zcode/surface', 'zcode-surface'],
    ['@deepseek-ai/dsh-time-context', 'time-context'],
    ['@deepseek-ai/dsh-skill-filesystem', 'skill-filesystem'],
    ['@deepseek-ai/dsh-tool-skill', 'tool-skill'],
    ['@deepseek-ai/dsh-tool-subagent-control', 'tool-subagent-control'],
    ['@deepseek-ai/dsh-tool-subagent', 'tool-subagent'],
    ['@deepseek-ai/dsh-workflow-ptc', 'workflow-ptc'],
    ['@deepseek-ai/dsh-tool-workflow', 'tool-workflow'],
    ['@deepseek-ai/dsh-command-compact', 'command-compact'],
    ['@deepseek-ai/dsh-tool-executor-ptc', 'tool-executor-ptc'],
    ['@deepseek-ai/dsh-tool-cordis', 'tool-cordis'],
    ['@deepseek-ai/dsh-plugin-manager/tools', 'plugin-manager-tools'],
    ['@deepseek-ai/dsh-plugin-market/tools', 'plugin-market-tools'],
  ])
  const modules = new Map([
    ['agent-preset', AgentPreset],
    ['zcode-context', contextRow],
    ['zcode-tools', toolsRow],
    ['zcode-surface', surfaceRow],
    ['time-context', timeContext],
    ['skill-filesystem', skillFilesystem],
    ['tool-skill', toolSkill],
    ['tool-subagent-control', toolSubagentControl],
    ['tool-subagent', toolSubagent],
    ['workflow-ptc', workflowPtc],
    ['tool-workflow', toolWorkflow],
    ['command-compact', commandCompact],
    ['tool-executor-ptc', toolExecutorPtc],
    ['tool-cordis', toolCordis],
    ['plugin-manager-tools', pluginManagerTools],
    ['plugin-market-tools', pluginMarketTools],
  ])
  for (const [name, module] of modules) loader.builtins[name] = module
  await loader.create({ name: 'cordis:prompt', config: { includeHarnessIdentity: false } })
  await loader.create({ name: 'cordis:tools' })
  await loader.create({ name: 'cordis:executor' })

  await mount(host, SessionProjectionRegistry)
  await mount(host, AgentRegistry)
  await mount(host, SessionStore)
  await mount(host, LocalFileSystem, { cwd: root })
  await mount(host, WorkingDirectoryService, { defaultDirectory: root })
  await mount(host, LocalSubprocessRuntime)
  await mount(host, LocalBashExecutor, { cwd: root, graceMs: 100 })
  await mount(host, TokenMeter)
  await mount(host, SandboxPolicyService, { mode: 'danger-full-access', workspaceRoot: root })
  await mount(host, LocalSandboxProvider)
  await mount(host, CommandRuntime)
  await mount(host, SkillRegistry)
  await mount(host, SubagentRuntime)
  await mount(host, subagentSpawn, { providerName: 'spawn' })
  await mount(host, subagentFork, { providerName: 'fork' })
  await mount(host, NodePtcRuntime)
  await mount(host, {
    name: 'preset-test-llm',
    apply(ctx: HostValue) {
      ctx.provide('llm', { resolveModelInfo: async () => ({ inputModalities: ['text'] }) })
    },
  })
  await mount(host, {
    name: 'preset-test-cordis-inspect',
    apply(ctx: HostValue) {
      ctx.provide('cordisInspect', { list: () => [], query: async () => ({ ok: true }) })
    },
  })
  const settingsFiber = await mount(host, hostRow) as HostValue
  await mount(host, AgentPresetRegistry, { default: 'zcode' })
  const presets = host.agentPresets

  const patchPath = fileURLToPath(new URL('../../cordis.patch.yml', import.meta.url))
  const rows = applyEntryPatches([], loadOverlayPatches('zcode-test', patchPath))
  for (const row of rows.filter((candidate: HostValue) => String(candidate.id).startsWith('preset-zcode'))) {
    await loader.create({
      id: row.id,
      name: 'cordis:agent-preset',
      config: { ...row.config, plugins: builtinRows(row.config.plugins, bindings) },
    })
  }
  await loader.await()

  const expected = [
    ['zcode', 'ZCode mode', 5],
    ['zcode-strict', 'ZCode strict mode', 6],
    ['zcode-ptc', 'ZCode PTC', 7],
    ['zcode-creator', 'ZCode Creator', 8],
  ]
  for (const [id] of expected) assert.deepEqual(await presets.resolve(id), { id })
  assert.deepEqual(
    (await presets.list())
      .filter((entry: HostValue) => String(entry.id).startsWith('zcode'))
      .map((entry: HostValue) => [entry.id, entry.name, entry.order, entry.broken]),
    expected.map(([id, name, order]) => [id, name, order, undefined]),
  )

  for (const name of ['working_directory', 'web_search', 'mcp__demo__search', 'read', 'bash', 'skill']) {
    host.tools.register(hostTool(name))
  }

  async function createAgent(id: string) {
    const session = host.sessions.create(id, { meta: { cwd: root } })
    const agent: HostValue = { id: session.id, session, ctx: undefined, options: {} }
    await mount(host, {
      name: `fixture-${id}`,
      inject: ['tools', 'systemPrompt'],
      async apply(ctx: HostValue) {
        const scope = createScope(ctx, agent)
        await scope.ctx.fiber.await()
        agent.ctx = scope.ctx
      },
    })
    const remove = await host.agents.register(agent)
    t.after(() => remove())
    return agent
  }

  async function visible(agent: HostValue): Promise<string[]> {
    const toolSet = await host.tools.resolve({
      agent,
      modelSelection: {},
      signal: new AbortController().signal,
    })
    try {
      const prompt = await host.systemPrompt.assemble({
        scope: scopeOf(agent.ctx),
        agent,
        toolSet,
      })
      return prompt.tools.map((tool: HostValue) => tool.name).sort()
    } finally {
      toolSet.dispose()
    }
  }

  const strict = await createAgent('zcode-strict-agent')
  await presets.mount(strict.ctx, 'zcode-strict')
  assert.equal(host.commands.find(strict, 'compact')?.name, 'compact')
  const compact = await host.commands.execute(strict, '/compact', [], new AbortController().signal)
  assert.equal(typeof compact?.commandId, 'string')
  assert.deepEqual(compact?.result, {
    kind: 'success',
    text: 'No compactable history yet.',
  })
  assert.deepEqual(
    await visible(strict),
    [...ZCODE_TOOLS, ...SKILL_TOOLS, ...DELEGATION_TOOLS].sort(),
    'strict exposes only ZCode, skill and delegation tools',
  )
  assert.equal(host.tools.get('web_search', scopeOf(strict.ctx)), undefined)

  const extended = await createAgent('zcode-agent')
  await presets.mount(extended.ctx, 'zcode')
  assert.deepEqual(
    await visible(extended),
    [...ZCODE_TOOLS, ...SKILL_TOOLS, ...DELEGATION_TOOLS, 'mcp__demo__search', 'web_search', 'working_directory'].sort(),
    'zcode keeps inherited tools that do not overlap with its own surface',
  )
  assert.equal(host.tools.get('read', scopeOf(extended.ctx)), undefined)
  assert.equal(host.tools.get('bash', scopeOf(extended.ctx)), undefined)

  const creator = await createAgent('zcode-creator-agent')
  await presets.mount(creator.ctx, 'zcode-creator')
  assert.deepEqual(
    await visible(creator),
    [
      ...ZCODE_TOOLS,
      ...SKILL_TOOLS,
      ...DELEGATION_TOOLS,
      ...INSPECT_TOOLS,
    ].sort(),
    'creator adds real Cordis inspection tools to the strict surface',
  )

  const ptc = await createAgent('zcode-ptc-agent')
  await presets.mount(ptc.ctx, 'zcode-ptc')
  assert.deepEqual(await visible(ptc), ['run_code'], 'PTC exposes one direct program transport')
  const ptcToolSet = await host.tools.resolve({
    agent: ptc,
    modelSelection: {},
    signal: new AbortController().signal,
  })
  try {
    const result = await host.tools.execute({
      calls: [{
        type: 'tool-call',
        id: 'ptc-read-proof',
        name: 'run_code',
        arguments: JSON.stringify({
          description: 'Read fixture through ZCode tool',
          code: `const result = await tools.Read({ file_path: ${JSON.stringify(readable)} });\nreturn result.content;`,
        }),
      }],
      agent: ptc,
      toolSet: ptcToolSet,
      signal: new AbortController().signal,
    })
    assert.match(JSON.stringify(result), /visible through nested ZCode Read/u)
  } finally {
    ptcToolSet.dispose()
  }

  await settingsFiber.update({ searchMode: 'tools', surfaceAllow: 'web_search' })
  host.emit('settings/document-updated', '@spectershell/dsh-harness-zcode', 1)
  assert.deepEqual(
    await visible(strict),
    [...ZCODE_TOOLS, ...SEARCH_TOOLS, ...SKILL_TOOLS, ...DELEGATION_TOOLS, 'web_search'].sort(),
    'live backend settings alter conditional ZCode tools and the inherited allow list',
  )

  host.tools.register(hostTool('late_non_overlap'))
  assert.ok((await visible(extended)).includes('late_non_overlap'), 'extended scopes accept late non-overlapping tools')
  assert.ok(!(await visible(strict)).includes('late_non_overlap'), 'strict scopes mask late inherited tools')
})
