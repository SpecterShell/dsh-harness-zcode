/**
 * Mounted proof for runtime microcompaction.
 *
 * Contract from pinned ZCode `compact/microcompact.ts` and the 2026-11-19
 * review: the runtime keeps a one-shot request projection. It replaces what the
 * model sees for the next request only, appends no session events, and never
 * mutates the durable surface. The newest five compactable tool results stay.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { native, mount, temporary } from '../../fixtures/native-host.ts'
import type { HostValue } from '../../fixtures/native-host.ts'
import { createFakeModel } from '../../fixtures/fake-model.ts'
import * as context from '../../../src/context/index.ts'
import {
  MICROCOMPACT_CLEARED_TEXT,
  MICROCOMPACT_KEEP_RECENT_TOOL_RESULTS,
  MICROCOMPACT_MIN_TOKEN_SAVINGS,
} from '../../../src/context/microcompaction.ts'

const { Context } = await native('cordis')
const { SessionStore } = await native('dsh-session')
const {
  LlmRuntime,
  ToolCallId,
  createToolResultMessage,
  createUserMessage,
} = await native('dsh-llm')
const { TokenMeter } = await native('dsh-token-meter')
const { SystemPrompt } = await native('dsh-system-prompt')
const { LocalFileSystem } = await native('dsh-fs-local')
const { WorkingDirectoryService } = await native('dsh-working-directory')
const { SessionProjectionRegistry } = await native('dsh-session-projection')
const sandbox = await native('dsh-sandbox-policy')
const SandboxPolicyService = sandbox.default ?? sandbox.SandboxPolicyService

const ENABLED = {
  headless: false,
  memoryEnabled: true,
  memoryExtractionEnabled: true,
  compactionEnabled: true,
  microcompactionEnabled: true,
  compactionThreshold: 0.9,
  microcompactionThreshold: 0.7,
  memoryMaxBytes: 32 * 1024,
  workspaceMemoryRoot: '.zcode/memory',
}

async function setup(t: TestContext, settings?: HostValue, results = 8) {
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
  const { model, requests } = createFakeModel()
  host.llm.registerAdapter(['fake'], model)
  await mount(host, context, {})
  if (settings) host.provide('zcodeSettings', { context: () => settings })

  const workspace = await temporary(t)
  const session = host.sessions.create(undefined, { meta: { cwd: workspace } })
  session.append('request/header', {
    header: { config: { provider: 'fake', model: 'fake' } },
    reason: 'initial',
  })
  session.append(
    'user/message',
    createUserMessage({ content: [{ type: 'text', text: 'start' }], source: { kind: 'user' } }),
    { surfaceOp: 'append' },
  )
  for (let index = 0; index < results; index += 1) {
    session.append(
      'tool/result',
      {
        turn: 1,
        step: 1,
        // Round-trip to drop optional members the session snapshot rejects.
        message: JSON.parse(
          JSON.stringify(
            createToolResultMessage({
              toolCallId: ToolCallId(`call-${String(index)}`),
              content: [{ type: 'text', text: `result ${String(index)} ${'x'.repeat(400)}` }],
            }),
          ),
        ) as never,
      },
      { surfaceOp: 'append' },
    )
  }
  const agent = {
    session,
    options: { provider: 'fake', model: 'fake' },
    ctx: { fiber: { assertActive() {} } },
  }
  return { host, session, agent, requests }
}

function serviceOf(host: HostValue): HostValue {
  const service = host.get?.('microcompaction') ?? host.microcompaction
  assert.notEqual(service, undefined, 'the context row provided no microcompaction service')
  return service
}

/** Drain one model request so the projection listener runs. */
async function streamOnce(host: HostValue, session: HostValue) {
  const chunks: unknown[] = []
  for await (const chunk of host.llm.stream({
    provider: 'fake',
    model: 'fake',
    messages: session.deriveMessages(),
    sessionId: session.id,
    maxTokens: 16,
    signal: new AbortController().signal,
    purpose: 'microcompaction-proof',
  })) {
    chunks.push(chunk)
  }
  return chunks
}

test('microcompaction is off by default and appends nothing', async (t) => {
  const { host, session, agent } = await setup(t)
  const before = session.deriveMessages()
  const eventsBefore = session.snapshotEvents().length

  const result = serviceOf(host).compactIfNeeded(agent, { estimatedTokens: 900, contextWindow: 1000 })

  assert.deepEqual(result, { applied: false, cleared: 0, tokensSaved: 0 })
  assert.deepEqual(session.deriveMessages(), before)
  assert.equal(session.snapshotEvents().length, eventsBefore)
})

test('with pressure the oldest tool results are cleared and the newest five stay', async (t) => {
  const { host, session, agent } = await setup(t, ENABLED, 10)
  const before = session.deriveMessages()
  const eventsBefore = session.snapshotEvents().length

  const result = serviceOf(host).compactIfNeeded(agent, { estimatedTokens: 900, contextWindow: 1000 })

  assert.equal(result.applied, true)
  assert.equal(result.cleared, 10 - MICROCOMPACT_KEEP_RECENT_TOOL_RESULTS)
  assert.ok(result.tokensSaved > MICROCOMPACT_MIN_TOKEN_SAVINGS)
  assert.deepEqual(session.deriveMessages(), before, 'the durable surface changed')
  assert.equal(session.snapshotEvents().length, eventsBefore, 'microcompaction appended an event')
})

test('the cleared text reaches the next request and nothing else does', async (t) => {
  const { host, session, agent, requests } = await setup(t, ENABLED, 10)
  serviceOf(host).compactIfNeeded(agent, { estimatedTokens: 900, contextWindow: 1000 })
  const eventsBefore = session.snapshotEvents().length

  await streamOnce(host, session)

  const sent = requests.at(-1)?.messages ?? []
  const text = sent
    .map((message: HostValue) =>
      (message.content ?? [])
        .filter((block: HostValue) => block.type === 'text')
        .map((block: HostValue) => block.text)
        .join('\n'),
    )
    .join('\n')
  assert.match(text, new RegExp(MICROCOMPACT_CLEARED_TEXT.replace(/[[\]]/gu, '\\$&')), 'no cleared marker in the request')
  assert.match(text, /result 9 /, 'the newest tool result was cleared from the request')
  assert.equal(session.snapshotEvents().length, eventsBefore, 'the request projection appended an event')

  // The projection is one-shot: a second request carries the original text.
  await streamOnce(host, session)
  const again = requests.at(-1)?.messages ?? []
  const againText = again
    .map((message: HostValue) =>
      (message.content ?? [])
        .filter((block: HostValue) => block.type === 'text')
        .map((block: HostValue) => block.text)
        .join('\n'),
    )
    .join('\n')
  assert.doesNotMatch(againText, new RegExp(MICROCOMPACT_CLEARED_TEXT.replace(/[[\]]/gu, '\\$&')))
})

test('a clear that frees less than the minimum is refused', async (t) => {
  const { host, session, agent } = await setup(t, ENABLED, 6)
  const result = serviceOf(host).compactIfNeeded(agent, { estimatedTokens: 900, contextWindow: 1000 })
  assert.equal(result.applied, false)
  assert.equal(result.cleared, 0)
  assert.deepEqual(session.deriveMessages(), session.deriveMessages())
})

test('below the pressure threshold nothing is projected', async (t) => {
  const { host, session, agent } = await setup(t, ENABLED, 10)
  const result = serviceOf(host).compactIfNeeded(agent, { estimatedTokens: 100, contextWindow: 1000 })
  assert.deepEqual(result, { applied: false, cleared: 0, tokensSaved: 0 })
  await streamOnce(host, session)
  assert.deepEqual(session.deriveMessages(), session.deriveMessages())
})
