/**
 * Runtime regression proof for the post-compaction restore window.
 *
 * Files are read through the registered `Read` tool, so touch records come from
 * real tool execution. Compaction runs through the mounted engine and the next
 * model request is captured by a registered adapter.
 *
 * Maintenance reads must fail closed. Restore skips a candidate when the
 * permission verdict is `deny`, `ask`, `indeterminate` or `unavailable`, and
 * only restores files whose verdict is `allow`. Asking the user during
 * maintenance is not an option, so `ask` behaves like a skip.
 */
import assert from 'node:assert/strict'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
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

async function setup(t: TestContext, override?: (path: string) => string, withExecutor = true) {
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
  if (withExecutor) await mount(host, executorModule)
  const { model, requests } = createFakeModel()
  host.llm.registerAdapter(['fake'], model)
  await mount(host, toolsRow)
  await mount(host, context, {})

  // The explicit override is supplemental; the default path runs the real tool
  // pipeline, so no policy service is provided unless a test asks for one.
  if (override) {
    host.provide('maintenanceReadPolicy', { verdict: (path: string) => override(path) })
  }

  const session = host.sessions.create(undefined, { meta: { cwd: workspace } })
  session.append('request/header', {
    header: { config: { provider: 'fake', model: 'fake' } },
    reason: 'initial',
  })
  session.append('working-directory/change', { cwd: workspace })
  sandbox.setSandboxMode(session, 'workspace-write')
  const agent = {
    session,
    options: { provider: 'fake', model: 'fake' },
    ctx: { fiber: { assertActive() {} } },
    runMaintenance: async <T>(task: (signal: AbortSignal) => Promise<T>) =>
      task(new AbortController().signal),
  }
  return { host, session, agent, workspace, requests }
}

async function readFile(host: HostValue, agent: HostValue, id: string, path: string) {
  const result = await host.tools.execute({
    calls: [{ type: 'tool-call', id, name: 'Read', arguments: JSON.stringify({ file_path: path }) }],
    signal: new AbortController().signal,
    agent,
  })
  const content = JSON.stringify(result)
  assert.doesNotMatch(content, /"isError":true/, `Read failed: ${content.slice(0, 300)}`)
}

async function compactionOf(host: HostValue) {
  const service = host.get?.('compaction') ?? host.compaction
  assert.notEqual(service, undefined, 'the context row provided no compaction service')
  return service as { compactNow(agent: unknown, signal: AbortSignal): Promise<unknown> }
}

/** Run one model request so the adapter records what it was asked. */
async function captureRequest(host: HostValue, session: HostValue) {
  for await (const _chunk of host.llm.stream({
    provider: 'fake',
    model: 'fake',
    messages: session.deriveMessages(),
    signal: new AbortController().signal,
    purpose: 'restore-proof',
  })) {
    // Drain.
  }
}

async function seed(session: HostValue, text: string) {
  session.append(
    'user/message',
    createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
    { surfaceOp: 'append' },
  )
}

test('both files read through the tool are restored with current contents', async (t) => {
  const { host, session, agent, workspace, requests } = await setup(t)
  await writeFile(join(workspace, 'a.txt'), 'first version of a\n', 'utf8')
  await mkdir(join(workspace, 'sub'), { recursive: true })
  await writeFile(join(workspace, 'sub/b.txt'), 'first version of b\n', 'utf8')
  await seed(session, 'read both')
  await readFile(host, agent, 'call-a', join(workspace, 'a.txt'))
  await readFile(host, agent, 'call-b', join(workspace, 'sub/b.txt'))

  await writeFile(join(workspace, 'a.txt'), 'second version of a\n', 'utf8')
  await writeFile(join(workspace, 'sub/b.txt'), 'second version of b\n', 'utf8')
  const before = requests.length
  await (await compactionOf(host)).compactNow(agent, new AbortController().signal)
  await captureRequest(host, session)

  const seen = JSON.stringify(requests.slice(before))
  assert.match(seen, /second version of a/, 'a.txt was not restored with current contents')
  assert.match(seen, /second version of b/, 'sub/b.txt was not restored with current contents')
  assert.doesNotMatch(seen, /first version of a/, 'a stale copy of a.txt was restored')
})

test('an alias and a relative spelling become one restore candidate', async (t) => {
  const { host, session, agent, workspace, requests } = await setup(t)
  await writeFile(join(workspace, 'alias.txt'), 'aliased body one\n', 'utf8')
  await seed(session, 'read it three ways')
  await readFile(host, agent, 'call-1', join(workspace, 'alias.txt'))
  await readFile(host, agent, 'call-2', './alias.txt')
  await readFile(host, agent, 'call-3', 'alias.txt')

  await writeFile(join(workspace, 'alias.txt'), 'aliased body two\n', 'utf8')
  const before = requests.length
  await (await compactionOf(host)).compactNow(agent, new AbortController().signal)
  await captureRequest(host, session)

  const seen = JSON.stringify(requests.slice(before))
  const occurrences = seen.split('aliased body two').length - 1
  assert.equal(occurrences, 1, `the same file was restored ${String(occurrences)} times`)
})

test('real pre-execute policy: deny, ask and indeterminate all skip', async (t) => {
  const { host, session, agent, workspace, requests } = await setup(t)
  for (const name of ['denied.txt', 'asked.txt', 'unknown.txt', 'allowed.txt']) {
    await writeFile(join(workspace, name), `body of ${name}\n`, 'utf8')
  }
  // The real tool pipeline gate decides, exactly as a deployment policy would.
  // Seeding reads happen before the maintenance phase and stay allowed.
  let phase: 'seed' | 'restore' = 'seed'
  host.on('tools/pre-execute', (payload: HostValue, next: () => unknown) => {
    if (phase === 'seed') return next()
    const args = payload?.arguments
    const path = typeof args?.file_path === 'string' ? args.file_path : ''
    if (path.endsWith('denied.txt')) return { kind: 'deny', reason: 'denied by policy' }
    if (path.endsWith('asked.txt')) return { kind: 'ask' }
    if (path.endsWith('unknown.txt')) throw new Error('policy evaluation failed')
    return next()
  })
  await seed(session, 'read four files')
  for (const [index, name] of ['denied.txt', 'asked.txt', 'unknown.txt', 'allowed.txt'].entries()) {
    await readFile(host, agent, `call-${String(index)}`, join(workspace, name))
  }

  phase = 'restore'
  const before = requests.length
  await (await compactionOf(host)).compactNow(agent, new AbortController().signal)
  await captureRequest(host, session)

  const seen = JSON.stringify(requests.slice(before))
  assert.doesNotMatch(seen, /body of denied\.txt/, 'a denied file was restored')
  assert.doesNotMatch(seen, /body of asked\.txt/, 'an ask-verdict file was restored without an approval channel')
  assert.doesNotMatch(seen, /body of unknown\.txt/, 'an indeterminate-verdict file was restored')
  assert.match(seen, /body of allowed\.txt/, 'an allowed file was not restored')
})

test('with no executor the restore path fails closed', async (t) => {
  const { host, session, agent, workspace, requests } = await setup(t, undefined, false)
  await writeFile(join(workspace, 'plain.txt'), 'plain body\n', 'utf8')
  await seed(session, 'read one file')
  // Without an executor the tool read cannot preflight, so no touch is recorded.
  await assert.rejects(async () => {
    await readFile(host, agent, 'call-plain', join(workspace, 'plain.txt'))
  })
  const before = requests.length
  await (await compactionOf(host)).compactNow(agent, new AbortController().signal)
  await captureRequest(host, session)

  const seen = JSON.stringify(requests.slice(before))
  assert.doesNotMatch(seen, /plain body/, 'restore read a file without an executable pipeline')
})

test('a file that cannot be read at restore time is skipped, not faked', async (t) => {
  const { host, session, agent, workspace, requests } = await setup(t)
  await writeFile(join(workspace, 'locked.txt'), 'locked body\n', 'utf8')
  await writeFile(join(workspace, 'open.txt'), 'open body one\n', 'utf8')
  await seed(session, 'read both files')
  await readFile(host, agent, 'call-a', join(workspace, 'locked.txt'))
  await readFile(host, agent, 'call-b', join(workspace, 'open.txt'))

  await chmod(join(workspace, 'locked.txt'), 0o000)
  await writeFile(join(workspace, 'open.txt'), 'open body two\n', 'utf8')
  const before = requests.length
  await (await compactionOf(host)).compactNow(agent, new AbortController().signal)
  await captureRequest(host, session)

  const seen = JSON.stringify(requests.slice(before))
  assert.doesNotMatch(seen, /locked body/, 'an unreadable file was restored as if readable')
  assert.match(seen, /open body two/, 'the readable file was not restored')
})

test('an available approval responder is never consulted during restore', async (t) => {
  const { host, session, agent, workspace, requests } = await setup(t)
  let approvalCalls = 0
  // A real responder exists and would say yes if anyone asked.
  host.provide('approval', {
    request: async () => {
      approvalCalls += 1
      return 'allowed-once'
    },
  })
  let phase: 'seed' | 'restore' = 'seed'
  host.on('tools/pre-execute', (payload: HostValue, next: () => unknown) => {
    if (phase === 'seed') return next()
    const path = typeof payload?.arguments?.file_path === 'string' ? payload.arguments.file_path : ''
    if (path.endsWith('asked.txt')) return { kind: 'ask' }
    return next()
  })
  await writeFile(join(workspace, 'asked.txt'), 'body of asked.txt\n', 'utf8')
  await writeFile(join(workspace, 'allowed.txt'), 'body of allowed.txt\n', 'utf8')
  await seed(session, 'read both')
  await readFile(host, agent, 'call-1', join(workspace, 'asked.txt'))
  await readFile(host, agent, 'call-2', join(workspace, 'allowed.txt'))

  phase = 'restore'
  const before = requests.length
  await (await compactionOf(host)).compactNow(agent, new AbortController().signal)
  await captureRequest(host, session)

  const seen = JSON.stringify(requests.slice(before))
  assert.equal(approvalCalls, 0, 'restore asked an approval responder during maintenance')
  assert.doesNotMatch(seen, /body of asked\.txt/, 'the ask-verdict file was restored')
  assert.match(seen, /body of allowed\.txt/, 'the allowed file was not restored')
})

test('denying the original relative spelling is enough to skip the file', async (t) => {
  const { host, session, agent, workspace, requests } = await setup(t)
  let phase: 'seed' | 'restore' = 'seed'
  host.on('tools/pre-execute', (payload: HostValue, next: () => unknown) => {
    if (phase === 'seed') return next()
    const path = typeof payload?.arguments?.file_path === 'string' ? payload.arguments.file_path : ''
    // Only the exact spelling the model used is denied; the canonical path allows.
    if (path === 'alias-spelling.txt') return { kind: 'deny', reason: 'original spelling denied' }
    return next()
  })
  await writeFile(join(workspace, 'alias-spelling.txt'), 'alias spelling body\n', 'utf8')
  await seed(session, 'read it relatively')
  await readFile(host, agent, 'call-rel', 'alias-spelling.txt')

  phase = 'restore'
  const before = requests.length
  await (await compactionOf(host)).compactNow(agent, new AbortController().signal)
  await captureRequest(host, session)

  const seen = JSON.stringify(requests.slice(before))
  assert.doesNotMatch(seen, /alias spelling body/, 'a file denied under its original spelling was restored')
})

test('a working-directory change after the read does not break restore policy', async (t) => {
  const { host, session, agent, workspace, requests } = await setup(t)
  const first = join(workspace, 'one')
  const second = join(workspace, 'two')
  await mkdir(first, { recursive: true })
  await mkdir(second, { recursive: true })
  await writeFile(join(first, 'cd.txt'), 'cd body one\n', 'utf8')
  await writeFile(join(second, 'cd.txt'), 'cd body two\n', 'utf8')
  await seed(session, 'read relatively')

  const signal = new AbortController().signal
  await host.workingDirectory.set(agent, first, signal)
  assert.equal(await host.workingDirectory.ensure(agent, signal), first)
  await readFile(host, agent, 'call-cd', 'cd.txt')

  const paths: string[] = []
  host.on('tools/pre-execute', (payload: HostValue, next: () => unknown) => {
    const path = typeof payload?.arguments?.file_path === 'string' ? payload.arguments.file_path : ''
    paths.push(path)
    return next()
  })

  // Move the effective cwd after the read; the compaction cwd is what counts.
  await host.workingDirectory.set(agent, second, signal)
  assert.equal(await host.workingDirectory.ensure(agent, signal), second)

  const before = requests.length
  await (await compactionOf(host)).compactNow(agent, new AbortController().signal)
  await captureRequest(host, session)

  const seen = JSON.stringify(requests.slice(before))
  assert.match(seen, /cd body one/, 'the file was not restored after the cwd change')
  assert.doesNotMatch(seen, /cd body two/, 'restore followed the new cwd instead of the captured one')
  assert.ok(
    paths.some((path) => path.startsWith(first)),
    `restore evaluated a path outside the captured cwd: ${paths.join(', ')}`,
  )
})

test('a partial read does not grant edit authority through restore', async (t) => {
  const { host, session, agent, workspace, requests } = await setup(t)
  let approvalCalls = 0
  host.provide('approval', {
    request: async () => {
      approvalCalls += 1
      return 'allowed-once'
    },
  })
  await writeFile(join(workspace, 'partial.txt'), 'line one\nline two\nline three\n', 'utf8')
  await seed(session, 'read the first line only')

  // A partial read: one line of three.
  const partial = await host.tools.execute({
    calls: [
      { type: 'tool-call', id: 'call-partial', name: 'Read', arguments: JSON.stringify({ file_path: join(workspace, 'partial.txt'), limit: 1 }) },
    ],
    signal: new AbortController().signal,
    agent,
  })
  assert.doesNotMatch(JSON.stringify(partial), /"isError":true/, 'the partial read itself failed')

  const before = requests.length
  await (await compactionOf(host)).compactNow(agent, new AbortController().signal)
  await captureRequest(host, session)
  assert.equal(approvalCalls, 0, 'restore consulted the approval responder')

  // Editing content the model never fully read must still be refused: restore
  // must not be treated as a full observation of the file.
  const edit = await host.tools.execute({
    calls: [
      {
        type: 'tool-call',
        id: 'call-edit',
        name: 'Edit',
        arguments: JSON.stringify({
          file_path: join(workspace, 'partial.txt'),
          old_string: 'line three',
          new_string: 'line three edited',
        }),
      },
    ],
    signal: new AbortController().signal,
    agent,
  })
  const json = JSON.stringify(edit)
  assert.match(json, /"isError":true/, 'restore granted edit authority from a partial read')
  assert.match(json, /read|observ|full|stale|current/i, `unexpected refusal: ${json.slice(0, 300)}`)
})
