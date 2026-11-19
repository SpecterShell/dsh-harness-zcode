/**
 * One scored model cell against the real AxonHub provider.
 *
 * Composition is the same app-equivalent stack the end-to-end proof uses: the
 * real loader, preset registry, preset rows, agent loop, tools, executor,
 * filesystem, subprocess, sandbox, shell and token meter. The only difference
 * is the model: a real provider row (`dsh-llm-pi-ai`) instead of a scripted
 * adapter.
 *
 * The provider key is resolved from the operator's stored credential ref into
 * this process's environment. It is never printed and never written to disk.
 *
 * Usage:
 *   node eval/scored/runner.ts <workspace> <task-file> <record-dir>
 */
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { native, mount } from '../../test/fixtures/native-host.ts'
import type { HostValue } from '../../test/fixtures/native-host.ts'

const MODEL = { provider: 'axonhub', model: 'glm-5.3-flash' } as const

/**
 * The credential file the host credential store reads. The key is never copied
 * into this process's environment, so a tool-spawned child cannot inherit it.
 */
const CREDENTIALS_FILE = join(homedir(), '.dsh', '.credentials.yaml')

async function main(): Promise<void> {
  const [workspaceArg, taskFile, recordDir] = process.argv.slice(2)
  if (!workspaceArg || !taskFile || !recordDir) {
    throw new Error('usage: runner.ts <workspace> <task-file> <record-dir>')
  }
  const workspace = workspaceArg
  if (process.env.AXONHUB_API_KEY !== undefined) {
    throw new Error('AXONHUB_API_KEY must not be present in this process environment')
  }
  const task = (await readFile(taskFile, 'utf8')).trim()
  await mkdir(recordDir, { recursive: true })

  const { Context } = await native('cordis')
  const { Loader, Group } = await native('cordis-plugin-loader')
  const { applyEntryPatches } = await native('cordis-plugin-include')
  const { loadOverlayPatches } = await native('dsh-app-boot')
  const { SystemPrompt } = await native('dsh-system-prompt')
  const { ToolsService } = await native('dsh-tools')
  const executor = await native('dsh-tool-executor-native')
  const { SessionStore } = await native('dsh-session')
  const persistence = await native('dsh-session-persistence-jsonl')
  const { SessionProjectionRegistry } = await native('dsh-session-projection')
  const { LocalFileSystem } = await native('dsh-fs-local')
  const { LocalSubprocessRuntime } = await native('dsh-subprocess-local')
  const { WorkingDirectoryService } = await native('dsh-working-directory')
  const { SandboxPolicyService } = await native('dsh-sandbox-policy')
  const sandboxPolicyModule = await native('dsh-sandbox-policy')
  const LocalSandboxProvider = (await native('dsh-sandbox-local')).default
  const { LocalBashExecutor } = await native('dsh-bash-local')
  const { TokenMeter } = await native('dsh-token-meter')
  const { AgentRegistry } = await native('dsh-agent')
  const { LlmRuntime, createUserMessage } = await native('dsh-llm')
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
  const providerRow = await native('dsh-llm-pi-ai')
  const credentialsModule = await native('dsh-credentials-local')
  const credentials = credentialsModule.default ?? credentialsModule

  const hostRow = await import('../../src/host.ts')
  const contextRow = await import('../../src/context/index.ts')
  const toolsRow = await import('../../src/tools/index.ts')
  const surfaceRow = await import('../../src/surface.ts')

  const host = new Context() as HostValue
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
  ])) {
    loader.builtins[name] = module
  }
  await loader.create({ name: 'cordis:prompt', config: { includeHarnessIdentity: false } })
  await loader.create({ name: 'cordis:tools' })
  await loader.create({ name: 'cordis:executor' })

  const logRoot = join(recordDir, 'sessions')
  await mount(host, persistence, { root: logRoot })
  await mount(host, SessionStore)
  await mount(host, SessionProjectionRegistry)
  await mount(host, LocalFileSystem, { cwd: workspace })
  await mount(host, WorkingDirectoryService, { defaultDirectory: workspace })
  await mount(host, LocalSubprocessRuntime)
  await mount(host, SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: workspace })
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
  await mount(host, LlmRuntime)
  // The credential store resolves the provider's apiKeyEnv ref in memory.
  await mount(host, credentials, { filename: CREDENTIALS_FILE })
  await mount(host, providerRow, {
    providers: {
      axonhub: {
        displayName: 'AxonHub',
        api: 'anthropic-messages',
        baseURL: 'http://127.0.0.1:18090',
        apiKeyEnv: 'AXONHUB_API_KEY',
        models: [
          {
            id: MODEL.model,
            name: 'GLM-5.3-Flash',
            contextWindow: 128_000,
            maxTokens: 32_768,
            input: ['text'],
          },
        ],
      },
    },
  })
  await mount(host, hostRow)
  await mount(host, AgentPresetRegistry, { default: 'zcode' })
  const presets = host.agentPresets
  const patchPath = fileURLToPath(new URL('../../cordis.patch.yml', import.meta.url))
  const rows = applyEntryPatches([], loadOverlayPatches('zcode-scored', patchPath))
  const preset = rows.find((row: HostValue) => row.id === 'preset-zcode')
  if (preset === undefined) throw new Error('the zcode preset row is missing')
  const bind = (plugins: HostValue[]): HostValue[] =>
    plugins.map((row: HostValue) => {
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
  await loader.create({
    id: preset.id,
    name: 'cordis:agent-preset',
    config: { ...preset.config, plugins: bind(preset.config.plugins) },
  })
  await loader.await()
  await mount(host, AgentLoop)
  await loader.await()

  const handle = await host.agents.create({
    sessionId: `eval-${Date.now().toString(36)}`,
    agentOptions: { ...MODEL, cwd: workspace },
  })
  const agent = handle.agent ?? handle
  // The policy owner reads the mode from the session log; make the intent
  // explicit so the cell runs with workspace writes instead of the default.
  sandboxPolicyModule.setSandboxMode(agent.session, 'workspace-write')
  await presets.select(agent, 'zcode')
  const started = Date.now()
  await agent.followup(createUserMessage({ content: [{ type: 'text', text: task }], source: { kind: 'user' } }))
  await agent.whenIdle()
  // The log is written incrementally; flush before reading facts from disk.
  await host.sessions.flush?.(agent.session)
  const wallMs = Date.now() - started

  // Include sources the model created, but never a virtualenv, cache or the
  // preset's own workspace files: intent-to-add on everything would turn a
  // multi-hundred-megabyte directory into a patch the harness cannot apply.
  const status = execFileSync('git', ['-C', workspace, 'status', '--porcelain'], {
    encoding: 'utf8',
  })
  const excluded = /(^|\/)(\.venv[^/]*|node_modules|__pycache__|\.pytest_cache|\.zcode)(\/|$)/
  const created = status
    .split('\n')
    .filter((line) => line.startsWith('?? '))
    .map((line) => line.slice(3).trim())
    .filter((path) => path.length > 0 && !excluded.test(path))
  if (created.length > 0) execFileSync('git', ['-C', workspace, 'add', '-N', '--', ...created])
  execFileSync('git', ['-C', workspace, 'add', '-N', '-u'])
  const patch = execFileSync('git', ['-C', workspace, 'diff'], { encoding: 'utf8' })
  const session = agent.session
  const sessionId = session.id
  const logPath = await findLog(logRoot, sessionId)
  // Turns come from `turn/end` events, the same measure session-facts.mjs uses.
  const messages = session.deriveMessages().length
  const turns = countTurns(session)
  // Validate before retaining: the patch must apply to a pristine checkout,
  // and the session log must parse into facts.
  const patchFile = resolve(recordDir, 'patch.diff')
  await writeFile(patchFile, patch, 'utf8')
  // The patch must apply cleanly to a pristine checkout of the same commit.
  const checkRoot = join(recordDir, 'patch-check')
  await rm(checkRoot, { recursive: true, force: true })
  execFileSync('git', ['clone', '-q', '--no-hardlinks', workspace, checkRoot], { stdio: 'pipe' })
  execFileSync('git', ['-C', checkRoot, 'checkout', '-q', 'HEAD'], { stdio: 'pipe' })
  execFileSync('git', ['-C', checkRoot, 'apply', '--check', patchFile], { stdio: 'pipe' })

  // The session log must parse into facts before the row is retained.
  const factsText = execFileSync(
    process.execPath,
    [fileURLToPath(new URL('../round-1/session-facts.mjs', import.meta.url)), logPath ?? '', '--json'],
    { encoding: 'utf8' },
  )
  const facts = JSON.parse(factsText) as HostValue
  if (facts.model !== MODEL.model || facts.provider !== MODEL.provider) {
    throw new Error(`session facts disagree with the cell: ${String(facts.provider)}/${String(facts.model)}`)
  }
  await writeFile(join(recordDir, 'session-facts.json'), factsText, 'utf8')
  await writeFile(
    join(recordDir, 'cell.json'),
    `${JSON.stringify(
      {
        model: MODEL,
        preset: 'zcode',
        agentPreset: presets.presetForSession?.(session) ?? null,
        sessionId,
        sessionLog: logPath,
        cwd: workspace,
        turns,
        messages,
        wallMs,
        patchBytes: patch.length,
        host: native('cordis') !== undefined,
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  console.log(`cell done: ${MODEL.provider}/${MODEL.model} session=${sessionId} log=${logPath ?? 'missing'} wallMs=${wallMs}`)
  // Close the host and exit: an undisposed fiber keeps the event loop alive
  // after the record is written, which looks like a hung run.
  await host.fiber?.dispose?.()
  process.exit(0)
}

/** Locate the session log on disk, if the store persisted one. */
function countTurns(session: HostValue): number {
  let highest = 0
  const seq = typeof session.seq === 'number' ? session.seq : 0
  for (let index = 0; index < seq; index += 1) {
    const event = session.eventAt?.(index)
    if (event?.type !== 'turn/end') continue
    const turn = Number(event.data?.turn ?? 0)
    if (Number.isFinite(turn) && turn > highest) highest = turn
  }
  return highest
}

async function findLog(root: string, sessionId: string): Promise<string | undefined> {
  const walk = async (directory: string, depth: number): Promise<string | undefined> => {
    if (depth > 4) return undefined
    let entries
    try {
      entries = await readdir(directory)
    } catch {
      return undefined
    }
    for (const entry of entries) {
      const child = join(directory, entry)
      const info = await stat(child)
      if (info.isDirectory()) {
        if (entry === sessionId) {
          const inner = await readdir(child)
          const log = inner.find((name) => /\.jsonl(\.zstd|\.zst)?$/.test(name))
          if (log) return join(child, log)
        }
        const found = await walk(child, depth + 1)
        if (found) return found
      }
    }
    return undefined
  }
  return walk(root, 0)
}

await main()
