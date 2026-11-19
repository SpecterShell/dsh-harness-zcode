/**
 * Regression proofs for the two workspace-context fixes:
 *
 * 1. A resumed pre-step injects the workspace context recorded in the
 *    persisted `zcode/prompt-snapshot`, not freshly recomputed text.
 * 2. The memory read stays rooted at `sandboxPolicy.workspaceRoot` after the
 *    mutable working directory changes, and a configured root that escapes the
 *    workspace is rejected instead of read.
 */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { native, mount, temporary } from '../../fixtures/native-host.ts'
import type { HostValue } from '../../fixtures/native-host.ts'
import { createFakeModel } from '../../fixtures/fake-model.ts'
import * as context from '../../../src/context/index.ts'

const { Context } = await native('cordis')
const { SessionStore } = await native('dsh-session')
const { LlmRuntime } = await native('dsh-llm')
const { TokenMeter } = await native('dsh-token-meter')
const { SystemPrompt } = await native('dsh-system-prompt')
const { LocalFileSystem } = await native('dsh-fs-local')
const { WorkingDirectoryService } = await native('dsh-working-directory')
const { SessionProjectionRegistry } = await native('dsh-session-projection')
const sandbox = await native('dsh-sandbox-policy')
const SandboxPolicyService = sandbox.default ?? sandbox.SandboxPolicyService

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
  const { model } = createFakeModel()
  host.llm.registerAdapter(['fake'], model)
  await mount(host, context, {})
  if (settings) host.provide('zcodeSettings', { context: () => settings })

  const workspace = await temporary(t)
  const outside = await temporary(t)
  const session = host.sessions.create(undefined, { meta: { cwd: workspace } })
  session.append('request/header', {
    header: { config: { provider: 'fake', model: 'fake' } },
    reason: 'initial',
  })
  session.append('working-directory/change', { cwd: workspace })
  const agent = {
    session,
    options: { provider: 'fake', model: 'fake' },
    ctx: { fiber: { assertActive() {} } },
  }
  return { host, session, agent, workspace, outside }
}

/** Run the real pre-step waterfall and return the injected reminder text. */
async function preStep(host: HostValue, agent: HostValue): Promise<string> {
  const decision = await host.waterfall(
    'agent/pre-step',
    { agent, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [] }),
  )
  return (decision.messages ?? [])
    .map((message: HostValue) =>
      (message.content ?? [])
        .filter((block: HostValue) => block.type === 'text')
        .map((block: HostValue) => block.text)
        .join('\n'),
    )
    .join('\n')
}

test('a resumed pre-step injects the persisted workspace context, not fresh text', async (t) => {
  const { host, session, agent, workspace } = await setup(t)
  await writeFile(join(workspace, 'AGENTS.md'), 'rule one: keep the changelog\n', 'utf8')

  const first = await preStep(host, agent)
  assert.match(first, /rule one/, 'the first pre-step did not inject the instruction')
  const snapshotRecords = session
    .snapshotEvents()
    .filter((event: HostValue) => event.type === context.PROMPT_SNAPSHOT_EVENT)
  assert.equal(snapshotRecords.length, 1, 'the first pre-step persisted no prompt snapshot record')
  assert.equal(snapshotRecords[0].ignorable, true, 'the prompt snapshot record is not replay-safe')

  // The project document changes; a resumed step must keep the recorded text.
  await writeFile(join(workspace, 'AGENTS.md'), 'rule two: rewrite the changelog\n', 'utf8')
  const resumed = await preStep(host, agent)

  assert.match(resumed, /rule one/, 'the resumed step lost the persisted workspace context')
  assert.doesNotMatch(resumed, /rule two/, 'the resumed step recomputed the workspace context')
})

test('the memory read stays rooted at the policy workspace root after a cwd change', async (t) => {
  const { host, agent, workspace, outside } = await setup(t)
  await writeFile(join(workspace, 'AGENTS.md'), 'rule one\n', 'utf8')
  await mkdir(join(workspace, '.zcode/memory'), { recursive: true })
  await mkdir(join(outside, '.zcode/memory'), { recursive: true })
  await writeFile(join(workspace, '.zcode/memory/MEMORY.md'), 'rooted memory body\n', 'utf8')
  await writeFile(join(outside, '.zcode/memory/MEMORY.md'), 'outside memory body\n', 'utf8')

  // A Bash cd moves the mutable working directory outside the workspace.
  agent.session.append('working-directory/change', { cwd: outside })
  const text = await preStep(host, agent)

  assert.match(text, /rooted memory body/, 'the memory index was not read from the workspace root')
  assert.doesNotMatch(text, /outside memory body/, 'the memory index followed the mutable cwd')
})

test('a configured memory root that escapes the workspace is never read', async (t) => {
  const { host, agent, workspace, outside } = await setup(t, {
    headless: false,
    memoryEnabled: true,
    memoryExtractionEnabled: true,
    compactionEnabled: true,
    microcompactionEnabled: false,
    compactionThreshold: 0.9,
    microcompactionThreshold: 0.7,
    memoryMaxBytes: 32 * 1024,
    workspaceMemoryRoot: '../outside/.zcode/memory',
  })
  await writeFile(join(workspace, 'AGENTS.md'), 'rule one\n', 'utf8')
  await mkdir(join(outside, '.zcode/memory'), { recursive: true })
  await writeFile(join(outside, '.zcode/memory/MEMORY.md'), 'escaped memory body\n', 'utf8')

  // Rejecting the root may surface as a thrown error or as a skipped read.
  // Either is acceptable; reading the escaped file is not.
  let text = ''
  let rejection: unknown
  try {
    text = await preStep(host, agent)
  } catch (error) {
    rejection = error
  }
  assert.doesNotMatch(text, /escaped memory body/, 'an escaping memory root was read')
  if (rejection !== undefined) {
    assert.match(String(rejection), /inside the project working directory/)
  }
})
