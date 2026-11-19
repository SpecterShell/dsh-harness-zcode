/**
 * Mounted proof for interactive memory extraction.
 *
 * Contract, from pinned ZCode plus the review on 2026-11-19: a successful
 * interactive turn writes durable entries to `FACTS.md` first, then makes sure
 * `MEMORY.md` carries the stable pointer. A headless run, a disabled setting or
 * a failed turn writes nothing, and a facts write that fails must not leave a
 * pointer behind.
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

const { Context } = await native('cordis')
const { SessionStore } = await native('dsh-session')
const {
  LlmRuntime,
  createAssistantMessage,
  createUserMessage,
} = await native('dsh-llm')
const { TokenMeter } = await native('dsh-token-meter')
const { SystemPrompt } = await native('dsh-system-prompt')
const { LocalFileSystem } = await native('dsh-fs-local')
const { WorkingDirectoryService } = await native('dsh-working-directory')
const { SessionProjectionRegistry } = await native('dsh-session-projection')
const sandbox = await native('dsh-sandbox-policy')

const SandboxPolicyService = sandbox.default ?? sandbox.SandboxPolicyService
const setSandboxMode = sandbox.setSandboxMode

async function setup(t: TestContext, settings?: HostValue) {
  const host = new Context() as HostValue
  t.after(() => host.fiber.dispose())
  await mount(host, SessionProjectionRegistry)
  await mount(host, SessionStore)
  await mount(host, LlmRuntime)
  await mount(host, TokenMeter)
  await mount(host, SystemPrompt)
  await mount(host, LocalFileSystem)
  await mount(host, WorkingDirectoryService)
  await mount(host, SandboxPolicyService)
  // Extraction keeps bulleted lines, so the scripted model answers with one.
  const { model } = createFakeModel({ reply: '- Deploys go through staging.' })
  host.llm.registerAdapter(['fake'], model)
  await mount(host, context, {})
  if (settings) host.provide('zcodeSettings', { context: () => settings })

  const workspace = await temporary(t)
  await mkdir(join(workspace, '.zcode/memory'), { recursive: true })
  // The session cwd is the workspace root the sandbox policy reports, so the
  // memory files land in the temp workspace and not in the process cwd.
  const session = host.sessions.create(undefined, { meta: { cwd: workspace } })
  session.append('request/header', {
    header: { config: { provider: 'fake', model: 'fake' }, cwd: workspace },
    reason: 'initial',
  })
  session.append('working-directory/change', { cwd: workspace })
  setSandboxMode(session, 'workspace-write')
  session.append('turn/start', { turn: 1 })
  session.append(
    'user/message',
    createUserMessage({ content: [{ type: 'text', text: 'remember that deploys go through staging' }], source: { kind: 'user' } }),
    { surfaceOp: 'append' },
  )
  session.append(
    'assistant/message',
    {
      turn: 1,
      step: 1,
      stream: [],
      message: createAssistantMessage({
        source: { provider: 'fake', model: 'fake' },
        content: [{ type: 'text', text: 'Noted: deploys go through staging.' }],
      }),
    },
    { surfaceOp: 'append' },
  )
  session.append('turn/end', { turn: 1 })
  return { host, session, workspace, model }
}

function agentFor(session: HostValue) {
  return {
    session,
    options: { provider: 'fake', model: 'fake' },
    ctx: { fiber: { assertActive() {} } },
    runMaintenance: async <T>(task: (signal: AbortSignal) => Promise<T>) =>
      task(new AbortController().signal),
  }
}

async function fire(host: HostValue, event: string, payload: unknown) {
  if (typeof host.parallel === 'function') return host.parallel(event, payload)
  return host.emit(event, payload)
}

async function runTurn(host: HostValue, agent: HostValue) {
  const signal = new AbortController().signal
  await fire(host, 'agent/created', { agent, signal })
  await fire(host, 'agent/turn-stopping', { agent, turn: 1, signal })
}

test('an interactive turn writes FACTS.md and then the MEMORY.md pointer', async (t) => {
  const { host, session, workspace } = await setup(t)
  await runTurn(host, agentFor(session))

  const facts = await readFile(join(workspace, '.zcode/memory/FACTS.md'), 'utf8')
  const index = await readFile(join(workspace, '.zcode/memory/MEMORY.md'), 'utf8')
  assert.match(facts, /staging/, 'FACTS.md carries no extracted line')
  assert.match(index, /FACTS\.md/, 'MEMORY.md carries no pointer to FACTS.md')
})

test('a failed turn writes nothing', async (t) => {
  const { host, session, workspace } = await setup(t)
  const agent = agentFor(session)
  const signal = new AbortController().signal
  await fire(host, 'agent/created', { agent, signal })
  await fire(host, 'agent/error', { agent, turn: 1 })
  await fire(host, 'agent/turn-stopping', { agent, turn: 1, signal })

  await assert.rejects(readFile(join(workspace, '.zcode/memory/FACTS.md'), 'utf8'))
})

test('a headless run writes nothing', async (t) => {
  const { host, session, workspace } = await setup(t, {
    headless: true,
    memoryEnabled: true,
    memoryExtractionEnabled: true,
    compactionEnabled: true,
    microcompactionEnabled: false,
    compactionThreshold: 0.9,
    microcompactionThreshold: 0.7,
    memoryMaxBytes: 32 * 1024,
    workspaceMemoryRoot: '.zcode/memory',
  })
  await runTurn(host, agentFor(session))

  await assert.rejects(readFile(join(workspace, '.zcode/memory/FACTS.md'), 'utf8'))
})

test('a failed facts write leaves no pointer behind', async (t) => {
  const { host, session, workspace } = await setup(t)
  // Put a directory where FACTS.md belongs so the facts write cannot happen.
  await mkdir(join(workspace, '.zcode/memory/FACTS.md'), { recursive: true })

  await runTurn(host, agentFor(session))

  // The turn must not fail, and no pointer may exist without facts.
  await assert.rejects(readFile(join(workspace, '.zcode/memory/MEMORY.md'), 'utf8'))
})
