/**
 * An app-equivalent composition: the real Agent loop, the real preset registry
 * with the shipped ZCode rows, and a scripted model.
 *
 * Only the model is scripted. Every other participant is the host package a
 * profile mounts: sessions, projections, tools, executor, filesystem,
 * subprocess, sandbox policy, shell, working directory, token meter and the
 * preset registry. Nothing reads a profile or reaches the network.
 */
import type { TestContext } from 'node:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { native, mount, temporary } from './native-host.ts'
import type { HostValue } from './native-host.ts'
import { createFakeModel } from './fake-model.ts'
import type { FakeModelOptions } from './fake-model.ts'

/** One scripted model reply, in the shape the shared fake model serves. */
export type Script = NonNullable<FakeModelOptions['script']>[number]

/** A scripted text answer with no tool call. */
export function answer(text: string): Script {
  return { text }
}

/** A scripted tool call; the model's next step is the following entry. */
export function callTool(name: string, id: string, input: unknown): Script {
  return { toolCall: { id, name, input } }
}

/**
 * Compose the app and return the handles a test drives.
 * @param t - the calling test, which disposes the host and its temp root.
 * @param buildScript - replies in order; it receives the workspace path so a
 *   tool call can name a real fixture file.
 */
export async function agentApp(t: TestContext, buildScript: (workspace: string) => Script[] = () => []) {
  const root = await temporary(t)
  const workspace = join(root, 'workspace')
  await mkdir(workspace, { recursive: true })
  await writeFile(join(workspace, 'notes.txt'), 'alpha\nbeta\n')

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
  const { SandboxPolicyService } = await native('dsh-sandbox-policy')
  const LocalSandboxProvider = (await native('dsh-sandbox-local')).default
  const { LocalBashExecutor } = await native('dsh-bash-local')
  const { TokenMeter } = await native('dsh-token-meter')
  const { AgentRegistry } = await native('dsh-agent')
  const AgentLoop = (await native('dsh-agent-loop')).default
  const AgentPreset = await native('dsh-agent-preset')
  const { AgentPresetRegistry } = await native('dsh-agent-preset-registry')
  const { CommandRuntime } = await native('dsh-commands')
  const timeContext = await native('dsh-time-context')
  const commandCompact = await native('dsh-command-compact')
  const SkillRegistry = (await native('dsh-skill')).default
  const skillFilesystem = await native('dsh-skill-filesystem')
  const toolSkill = await native('dsh-tool-skill')
  const { SubagentRuntime } = await native('dsh-subagent')
  const subagentSpawn = await native('dsh-subagent-spawn-in-process')
  const subagentFork = await native('dsh-subagent-fork-in-process')
  const workflowPtc = await native('dsh-workflow-ptc')
  const toolWorkflow = await native('dsh-tool-workflow')
  const toolSubagentControl = await native('dsh-tool-subagent-control')
  const toolSubagent = await native('dsh-tool-subagent')
  const NodePtcRuntime = (await native('dsh-ptc-runtime-node')).default

  const hostRow = await import('../../src/host.ts')
  const contextRow = await import('../../src/context/index.ts')
  const toolsRow = await import('../../src/tools/index.ts')
  const surfaceRow = await import('../../src/surface.ts')

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
  for (const [name, module] of new Map<string, unknown>([
    ['agent-preset', AgentPreset],
    ['zcode-context', contextRow],
    ['zcode-tools', toolsRow],
    ['zcode-surface', surfaceRow],
    ['time-context', timeContext],
    ['command-compact', commandCompact],
    ['skill-filesystem', skillFilesystem],
    ['tool-skill', toolSkill],
    ['workflow-ptc', workflowPtc],
    ['tool-workflow', toolWorkflow],
    ['tool-subagent-control', toolSubagentControl],
    ['tool-subagent', toolSubagent],
  ])) loader.builtins[name] = module
  await loader.create({ name: 'cordis:prompt', config: { includeHarnessIdentity: false } })
  await loader.create({ name: 'cordis:tools' })
  await loader.create({ name: 'cordis:executor' })

  await mount(host, SessionStore)
  await mount(host, SessionProjectionRegistry)
  await mount(host, LocalFileSystem, { cwd: workspace })
  await mount(host, WorkingDirectoryService, { defaultDirectory: workspace })
  await mount(host, LocalSubprocessRuntime)
  await mount(host, SandboxPolicyService, { mode: 'read-only', workspaceRoot: workspace })
  await mount(host, LocalSandboxProvider)
  await mount(host, LocalBashExecutor, { cwd: workspace, graceMs: 100 })
  await mount(host, TokenMeter)
  await mount(host, AgentRegistry)
  await mount(host, CommandRuntime)
  await mount(host, SkillRegistry)
  await mount(host, SubagentRuntime)
  await mount(host, subagentSpawn, { providerName: 'spawn' })
  await mount(host, subagentFork, { providerName: 'fork' })
  await mount(host, NodePtcRuntime)

  // The real runtime, with the shared scripted adapter registered on one route.
  const { LlmRuntime } = await native('dsh-llm')
  const { model, requests } = createFakeModel({
    script: buildScript(workspace),
    reply: 'Nothing to save.',
  })
  await mount(host, LlmRuntime)
  host.llm.registerAdapter(['fake'], model)

  await mount(host, hostRow)
  await mount(host, AgentPresetRegistry, { default: 'zcode' })
  const presets = host.agentPresets
  const patchPath = fileURLToPath(new URL('../../cordis.patch.yml', import.meta.url))
  const rows = applyEntryPatches([], loadOverlayPatches('zcode-e2e', patchPath))
  const preset = rows.find((row: HostValue) => row.id === 'preset-zcode')
  if (preset === undefined) throw new Error('the zcode preset row is missing')
  const bind = (plugins: HostValue[]): HostValue[] => plugins.map((row: HostValue) => {
    if (row.group === true) return { ...row, name: 'cordis:group', config: bind(row.config ?? []) }
    const name = String(row.name)
    if (name === '@spectershell/dsh-harness-zcode/context') return { ...row, name: 'cordis:zcode-context' }
    if (name === '@spectershell/dsh-harness-zcode/tools') return { ...row, name: 'cordis:zcode-tools' }
    if (name === '@spectershell/dsh-harness-zcode/surface') return { ...row, name: 'cordis:zcode-surface' }
    if (name === '@deepseek-ai/dsh-time-context') return { ...row, name: 'cordis:time-context' }
    if (name === '@deepseek-ai/dsh-command-compact') return { ...row, name: 'cordis:command-compact' }
    if (name === '@deepseek-ai/dsh-skill-filesystem') return { ...row, name: 'cordis:skill-filesystem' }
    if (name === '@deepseek-ai/dsh-tool-skill') return { ...row, name: 'cordis:tool-skill' }
    if (name === '@deepseek-ai/dsh-workflow-ptc') return { ...row, name: 'cordis:workflow-ptc' }
    if (name === '@deepseek-ai/dsh-tool-workflow') return { ...row, name: 'cordis:tool-workflow' }
    if (name === '@deepseek-ai/dsh-tool-subagent-control') return { ...row, name: 'cordis:tool-subagent-control' }
    if (name === '@deepseek-ai/dsh-tool-subagent') return { ...row, name: 'cordis:tool-subagent' }
    return row
  })
  await loader.create({ id: preset.id, name: 'cordis:agent-preset', config: { ...preset.config, plugins: bind(preset.config.plugins) } })
  await loader.await()
  await mount(host, AgentLoop)
  await loader.await()

  return { host, loader, presets, requests, workspace, root }
}
