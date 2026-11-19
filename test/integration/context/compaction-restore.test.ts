/**
 * Full compaction and the post-compaction restore window, driven through the
 * registered tools. Files enter the restore window only because a real `Read`
 * of them succeeded, so nothing here passes on hand-written touch state.
 *
 * Contract from pinned ZCode `fec9759` (`compact-post-reminders.ts`): the newest
 * five eligible files are restored after the checkpoint, newest first, with a
 * reference notice instead of content when a file exceeds the per-file token
 * cap. A failed or truncated summary must not reach the surface.
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
import * as toolsRow from '../../../src/tools/index.ts'

const { Context } = await native('cordis')
const { SessionStore } = await native('dsh-session')
const { LlmRuntime, createUserMessage } = await native('dsh-llm')
const { TokenMeter } = await native('dsh-token-meter')
const { SystemPrompt } = await native('dsh-system-prompt')
const { ToolsService } = await native('dsh-tools')
const { LocalBashExecutor } = await native('dsh-bash-local')
const shellModule = await native('dsh-shell')
const ShellExecutor = shellModule.default ?? shellModule
const executorModule = await native('dsh-tool-executor-native')
const { LocalFileSystem } = await native('dsh-fs-local')
const { WorkingDirectoryService } = await native('dsh-working-directory')
const { SessionProjectionRegistry } = await native('dsh-session-projection')
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
  const { model } = createFakeModel()
  host.llm.registerAdapter(['fake'], model)
  await mount(host, toolsRow)
  await mount(host, context, {})

  const session = host.sessions.create(undefined, { meta: { cwd: workspace } })
  session.append('request/header', {
    header: { config: { provider: 'fake', model: 'fake' }, cwd: workspace },
    reason: 'initial',
  })
  session.append('working-directory/change', { cwd: workspace })
  sandbox.setSandboxMode(session, 'workspace-write')
  session.append(
    'user/message',
    createUserMessage({ content: [{ type: 'text', text: 'work' }], source: { kind: 'user' } }),
    { surfaceOp: 'append' },
  )
  const agent = {
    session,
    options: { provider: 'fake', model: 'fake' },
    ctx: { fiber: { assertActive() {} } },
    runMaintenance: async <T>(task: (signal: AbortSignal) => Promise<T>) =>
      task(new AbortController().signal),
  }
  return { host, session, agent, workspace, model }
}

/** Read a file through the registered tool; fail loudly if it did not work. */
async function read(host: HostValue, agent: HostValue, id: string, path: string) {
  const result = await host.tools.execute({
    calls: [{ type: 'tool-call', id, name: 'Read', arguments: JSON.stringify({ file_path: path }) }],
    signal: new AbortController().signal,
    agent,
  })
  const json = JSON.stringify(result)
  assert.doesNotMatch(json, /"isError":true/, `Read failed: ${json.slice(0, 300)}`)
}

async function compactionOf(host: HostValue) {
  const service = host.get?.('compaction') ?? host.compaction
  assert.notEqual(service, undefined, 'the context row provided no compaction service')
  return service as { compactNow(agent: unknown, signal: AbortSignal): Promise<unknown> }
}

/** Everything the model would see after the summary message. */
function afterSummary(session: HostValue, summary: string): string {
  const all: string[] = session.deriveMessages().map((message: HostValue) =>
    message.content
      .filter((block: HostValue) => block.type === 'text')
      .map((block: HostValue) => block.text)
      .join(''),
  )
  const index = all.findIndex((text) => text.includes(summary))
  assert.notEqual(index, -1, 'no compaction summary reached the surface')
  return all.slice(index + 1).join('\n')
}

test('the newest five of seven files read through the tool are restored', async (t) => {
  const { host, session, agent, workspace, model } = await setup(t)
  const names = ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt', 'f.txt', 'g.txt']
  for (const name of names) await writeFile(join(workspace, name), `content of ${name}\n`, 'utf8')
  for (const [index, name] of names.entries()) {
    await read(host, agent, `call-${String(index)}`, join(workspace, name))
  }

  await (await compactionOf(host)).compactNow(agent, new AbortController().signal)
  const restored = afterSummary(session, model.summary)

  for (const name of ['c.txt', 'd.txt', 'e.txt', 'f.txt', 'g.txt']) {
    assert.match(restored, new RegExp(`content of ${name}`), `${name} was not restored`)
  }
  assert.doesNotMatch(restored, /content of a\.txt/, 'the oldest file was restored')
  assert.doesNotMatch(restored, /content of b\.txt/, 'the second oldest file was restored')
  assert.ok(
    restored.indexOf('content of g.txt') < restored.indexOf('content of c.txt'),
    'restored files are not newest first',
  )
})

test('instruction files and the memory index are never restored', async (t) => {
  const { host, session, agent, workspace, model } = await setup(t)
  await writeFile(join(workspace, 'AGENTS.md'), 'workspace instruction body\n', 'utf8')
  await mkdir(join(workspace, '.zcode/memory'), { recursive: true })
  await writeFile(join(workspace, '.zcode/memory/MEMORY.md'), 'memory index body\n', 'utf8')
  await writeFile(join(workspace, 'code.ts'), 'export const value = 1\n', 'utf8')
  await read(host, agent, 'call-agents', join(workspace, 'AGENTS.md'))
  await read(host, agent, 'call-memory', join(workspace, '.zcode/memory/MEMORY.md'))
  await read(host, agent, 'call-code', join(workspace, 'code.ts'))

  await (await compactionOf(host)).compactNow(agent, new AbortController().signal)
  const restored = afterSummary(session, model.summary)

  assert.match(restored, /export const value = 1/, 'the ordinary read file was not restored')
  assert.doesNotMatch(restored, /workspace instruction body/, 'an instruction file was restored')
  assert.doesNotMatch(restored, /memory index body/, 'the memory index was restored')
})

test('a file over the per-file cap becomes a reference notice', async (t) => {
  const { host, session, agent, workspace, model } = await setup(t)
  await writeFile(join(workspace, 'big.txt'), 'x'.repeat(6_000 * 4), 'utf8')
  await read(host, agent, 'call-big', join(workspace, 'big.txt'))

  await (await compactionOf(host)).compactNow(agent, new AbortController().signal)
  const restored = afterSummary(session, model.summary)

  assert.match(restored, /too large to include/, 'no reference notice for the oversize file')
  assert.doesNotMatch(restored, /x{400}/, 'the oversize body was restored inline')
})

test('a failed summary leaves the surface untouched', async (t) => {
  const { host, session, agent, workspace, model } = await setup(t)
  await writeFile(join(workspace, 'a.txt'), 'content of a.txt\n', 'utf8')
  await read(host, agent, 'call-a', join(workspace, 'a.txt'))
  const before = session.deriveMessages()
  model.fail = true

  await assert.rejects(async () => {
    await (await compactionOf(host)).compactNow(agent, new AbortController().signal)
  })
  assert.deepEqual(session.deriveMessages(), before, 'a failed summary changed the surface')
})

test('a summary truncated at the token cap fails closed', async (t) => {
  const { host, session, agent, workspace, model } = await setup(t)
  await writeFile(join(workspace, 'a.txt'), 'content of a.txt\n', 'utf8')
  await read(host, agent, 'call-a', join(workspace, 'a.txt'))
  model.queue.push({ text: 'cut off summary', finish: 'max-tokens' })
  const before = session.deriveMessages()

  await assert.rejects(
    () => (compactionOf(host) as unknown as Promise<HostValue>).then((service) =>
      (service as { compactNow(a: unknown, s: AbortSignal): Promise<unknown> }).compactNow(
        agent,
        new AbortController().signal,
      ),
    ),
    /Compaction summary failed/,
  )
  assert.deepEqual(session.deriveMessages(), before, 'a truncated summary changed the surface')
})

test('a second compaction restores current disk content', async (t) => {
  const { host, session, agent, workspace, model } = await setup(t)
  await writeFile(join(workspace, 'a.txt'), 'first version of a\n', 'utf8')
  await read(host, agent, 'call-a', join(workspace, 'a.txt'))
  await (await compactionOf(host)).compactNow(agent, new AbortController().signal)
  assert.match(afterSummary(session, model.summary), /first version of a/)

  await writeFile(join(workspace, 'a.txt'), 'second version of a\n', 'utf8')
  await read(host, agent, 'call-a2', join(workspace, 'a.txt'))
  await (await compactionOf(host)).compactNow(agent, new AbortController().signal)

  const restored = afterSummary(session, model.summary)
  assert.match(restored, /second version of a/, 'the second compaction restored stale content')
})
