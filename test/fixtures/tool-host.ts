/**
 * Compose the real services the ZCode tool row needs, plus one real Agent.
 *
 * The Agent is more than a stub: `WorkingDirectoryService.ensure()` asserts the
 * Agent's scope fiber is active and appends to its Session, so the fixture
 * mints a scoped context through a plugin and registers a real session. No
 * model, provider or profile participates.
 */
import type { TestContext } from 'node:test'
import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { native, mount, temporary } from './native-host.ts'
import type { HostValue } from './native-host.ts'

export interface ToolHostOptions {
  /** Initial `zcodeSettings.tools().searchMode`. */
  searchMode?: 'bash' | 'tools'
  /** Sandbox mode for the negative confinement proofs; omitted leaves the host unconfined. */
  sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access'
  /** Mount the enforcement provider. False composes a policy nothing can enforce. */
  sandboxProvider?: boolean
  /** Filesystem backend: the unconfined local one, or the policy-enforcing one. */
  fsMode?: 'local' | 'sandbox'
  /** Mount the shipped read-before-write observation row. Defaults to true, as a profile mounts it. */
  observe?: boolean
}

/** Mount a service provider the test keeps control of. */
async function provide(ctx: HostValue, name: string, value: unknown): Promise<void> {
  const fiber = ctx.plugin({
    name: `fixture-${name}`,
    apply(pluginCtx: HostValue) { pluginCtx.provide(name, value) },
  })
  await fiber.await()
}

/**
 * Build one host with the real tool registry, filesystem, subprocess runtime,
 * working directory, a real session and a scoped Agent.
 * @param t - the calling test, which disposes the host and its temp root.
 * @param options - search mode and sandbox mode.
 */
export async function toolHost(t: TestContext, options: ToolHostOptions = {}) {
  const root = await temporary(t)
  const workspace = join(root, 'workspace')
  await mkdir(workspace, { recursive: true })

  const { Context } = await native('cordis')
  const { SystemPrompt } = await native('dsh-system-prompt')
  const { ToolsService } = await native('dsh-tools')
  const executor = await native('dsh-tool-executor-native')
  const { SessionStore } = await native('dsh-session')
  const { SessionProjectionRegistry } = await native('dsh-session-projection')
  const { LocalFileSystem } = await native('dsh-fs-local')
  const { default: SandboxedFileSystem } = await native('dsh-fs-sandbox')
  const { LocalSubprocessRuntime } = await native('dsh-subprocess-local')
  const { WorkingDirectoryService } = await native('dsh-working-directory')
  const { SandboxPolicyService } = await native('dsh-sandbox-policy')
  const { createScope } = await native('dsh-scope')
  const toolsRow = await import('../../src/tools/index.ts')

  const host = new Context()
  t.after(() => host.fiber.dispose())
  await mount(host, SystemPrompt)
  await mount(host, ToolsService)
  await mount(host, executor.default ?? executor)
  await mount(host, SessionStore)
  await mount(host, SessionProjectionRegistry)
  await mount(host, options.fsMode === 'sandbox' ? SandboxedFileSystem : LocalFileSystem, { cwd: workspace })
  await mount(host, WorkingDirectoryService, { defaultDirectory: workspace })
  await mount(host, LocalSubprocessRuntime)
  if (options.observe !== false) {
    const observationPolicy = await native('dsh-fs-observation-policy')
    await mount(host, observationPolicy)
  }
  // Every deployment mounts a policy; the confined shell is what enforces it.
  await mount(host, SandboxPolicyService, {
    mode: options.sandboxMode ?? 'danger-full-access',
    workspaceRoot: workspace,
  })
  if (options.sandboxMode === undefined) {
    const { LocalBashExecutor } = await native('dsh-bash-local')
    await mount(host, LocalBashExecutor, { cwd: workspace, graceMs: 100 })
  } else {
    const { SandboxBashExecutor } = await native('dsh-bash-sandbox')
    const { LocalSandboxProvider } = await native('dsh-sandbox-local')
    if (options.sandboxProvider !== false) await mount(host, LocalSandboxProvider)
    await mount(host, SandboxBashExecutor, { cwd: workspace, graceMs: 100 })
  }

  let searchMode = options.searchMode ?? 'bash'
  await provide(host, 'zcodeSettings', {
    tools: () => ({ searchMode, preserveRunCode: true }),
    surfaceAllow: () => [],
  })

  const session = host.sessions.create('zcode-tools', { meta: { cwd: workspace } })
  const agent: HostValue = { id: session.id, session, options: {}, ctx: undefined }
  await mount(host, {
    name: 'fixture-agent',
    inject: ['tools'],
    async apply(pluginCtx: HostValue) {
      const scope = createScope(pluginCtx, agent)
      await scope.ctx.fiber.await()
      agent.ctx = scope.ctx
    },
  })
  await mount(host, toolsRow)

  /** Call one registered tool the way the executor does, outside a model step. */
  const call = async (name: string, args: Record<string, unknown>, signal = new AbortController().signal) => {
    const tool = host.tools.get(name, agent)
    if (tool === undefined) throw new Error(`tool ${name} is not visible to the fixture Agent`)
    return await tool.execute(args, { callId: `call-${name}`, name, arguments: args, signal, agent })
  }

  /** Resolve one step's admission and return the tool names the model could call. */
  const stepNames = async () => {
    const signal = new AbortController().signal
    const toolSet = await host.tools.resolve({ agent, modelSelection: {}, signal })
    try {
      return host.tools.schemas(agent, toolSet).map((tool: HostValue) => tool.name).sort()
    } finally {
      toolSet.dispose()
    }
  }

  return {
    host,
    agent,
    session,
    root,
    workspace,
    call,
    stepNames,
    touches: () => toolsRow.zcodeFileTouches.touches(agent),
    setSearchMode: (mode: 'bash' | 'tools') => { searchMode = mode },
  }
}
