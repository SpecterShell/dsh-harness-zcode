/**
 * Runtime regression proof that memory crosses sessions through the workspace
 * root and that the index link resolves to the real fact.
 *
 * A turn in `pkg/a` writes `FACTS.md` and the `MEMORY.md` pointer under the
 * workspace root. A fresh sibling session in `pkg/b` receives the index, and a
 * real `Read` of the link target returns the actual fact. The fact body is not
 * required to arrive eagerly.
 */
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { native, mount, temporary } from '../../fixtures/native-host.ts'
import type { HostValue } from '../../fixtures/native-host.ts'
import { createFakeModel } from '../../fixtures/fake-model.ts'
import * as context from '../../../src/context/index.ts'
import * as toolsRow from '../../../src/tools/index.ts'

const { Context } = await native('cordis')
const { SessionStore } = await native('dsh-session')
const { LlmRuntime, createUserMessage } = await native('dsh-llm')
const { TokenMeter } = await native('dsh-token-meter')
const { SystemPrompt } = await native('dsh-system-prompt')
const { LocalFileSystem } = await native('dsh-fs-local')
const { WorkingDirectoryService } = await native('dsh-working-directory')
const { SessionProjectionRegistry } = await native('dsh-session-projection')
const { ToolsService } = await native('dsh-tools')
const { LocalBashExecutor } = await native('dsh-bash-local')
const shellModule = await native('dsh-shell')
const ShellExecutor = shellModule.default ?? shellModule
const executorModule = await native('dsh-tool-executor-native')
const sandbox = await native('dsh-sandbox-policy')
const SandboxPolicyService = sandbox.default ?? sandbox.SandboxPolicyService

async function setup(t: TestContext) {
  const host = new Context() as HostValue
  t.after(() => host.fiber.dispose())
  const workspace = await temporary(t)
  await mount(host, SessionProjectionRegistry)
  await mount(host, SessionStore)
  await mount(host, LlmRuntime)
  await mount(host, TokenMeter)
  await mount(host, SystemPrompt)
  await mount(host, LocalFileSystem, { cwd: workspace })
  await mount(host, WorkingDirectoryService, { defaultDirectory: workspace })
  await mount(host, SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: workspace })
  await mount(host, ShellExecutor)
  await mount(host, LocalBashExecutor, { cwd: workspace, graceMs: 100 })
  await mount(host, ToolsService)
  await mount(host, executorModule)
  const { model } = createFakeModel({ reply: '- Deploys go through staging.' })
  host.llm.registerAdapter(['fake'], model)
  await mount(host, toolsRow)
  await mount(host, context, {})
  return { host, workspace }
}

function agentFor(session: HostValue) {
  return {
    session,
    options: { provider: 'fake', model: 'fake' },
    ctx: { fiber: { assertActive() {} } },
  }
}

async function fire(host: HostValue, event: string, payload: unknown) {
  if (typeof host.parallel === 'function') return host.parallel(event, payload)
  return host.emit(event, payload)
}

test('a split-cwd sibling receives the index and the link resolves to the fact', { timeout: 60_000 }, async (t) => {
  const { host, workspace } = await setup(t)
  // Both sessions are created at one fixed sandbox workspace root. Their
  // effective cwd then moves independently through the real working-directory
  // service, which is what separates the root from the cwd.
  const repo = join(workspace, 'repo')
  const authorCwd = join(repo, 'packages/a')
  const siblingCwd = join(repo, 'packages/b')
  await mkdir(authorCwd, { recursive: true })
  await mkdir(siblingCwd, { recursive: true })
  await writeFile(join(authorCwd, 'AGENTS.md'), 'workspace rule\n', 'utf8')
  await mkdir(join(repo, '.zcode/memory'), { recursive: true })

  const authorSession = host.sessions.create(undefined, { meta: { cwd: repo } })
  authorSession.append('request/header', {
    header: { config: { provider: 'fake', model: 'fake' } },
    reason: 'initial',
  })
  sandbox.setSandboxMode(authorSession, 'workspace-write')
  authorSession.append(
    'user/message',
    createUserMessage({
      content: [{ type: 'text', text: 'remember that deploys go through staging' }],
      source: { kind: 'user' },
    }),
    { surfaceOp: 'append' },
  )
  const author = agentFor(authorSession)
  const signal = new AbortController().signal
  await host.workingDirectory.set(author, authorCwd, signal)
  assert.equal(
    await host.workingDirectory.ensure(author, signal),
    authorCwd,
    'the author agent cwd did not move to packages/a',
  )
  await fire(host, 'agent/created', { agent: author, signal })
  await fire(host, 'agent/turn-stopping', { agent: author, turn: 1, signal })

  // Both files live under the workspace root the policy reports for this cwd.
  const facts = await readFile(join(repo, '.zcode/memory/FACTS.md'), 'utf8')
  const index = await readFile(join(repo, '.zcode/memory/MEMORY.md'), 'utf8')
  assert.match(facts, /staging/, 'the authoring turn wrote no fact')
  assert.match(index, /FACTS\.md/, 'the index carries no link to the fact')

  // A fresh sibling session in another cwd, same workspace root.
  const siblingSession = host.sessions.create(undefined, { meta: { cwd: repo } })
  siblingSession.append('request/header', {
    header: { config: { provider: 'fake', model: 'fake' } },
    reason: 'initial',
  })
  sandbox.setSandboxMode(siblingSession, 'workspace-write')
  const sibling = agentFor(siblingSession)
  await host.workingDirectory.set(sibling, siblingCwd, signal)
  assert.equal(
    await host.workingDirectory.ensure(sibling, signal),
    siblingCwd,
    'the sibling agent cwd did not move to packages/b',
  )
  const decision = await host.waterfall(
    'agent/pre-step',
    { agent: sibling, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [] }),
  )
  const injected = JSON.stringify(decision.messages ?? [])
  assert.match(injected, /MEMORY\.md|memory index/iu, 'the sibling session received no memory index')

  // The link resolves through a real Read to the actual fact.
  const linked = /([\w./-]*FACTS\.md)/u.exec(index)?.[1]
  assert.ok(linked, 'the index link target is not a readable path')
  const target = join(repo, '.zcode/memory', linked.replace(/^.*\/\.zcode\/memory\//u, ''))
  const result = await host.tools.execute({
    calls: [
      {
        type: 'tool-call',
        id: 'call-facts',
        name: 'Read',
        arguments: JSON.stringify({ file_path: target }),
      },
    ],
    signal: new AbortController().signal,
    agent: sibling,
  })
  assert.match(JSON.stringify(result), /staging/, 'the link did not resolve to the fact')
})
