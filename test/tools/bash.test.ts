/**
 * Prove the Bash row's session model: the working directory carries across
 * calls, and nothing else does.
 *
 * Each call is a fresh `bash --noprofile --norc`, so an exported variable or a
 * shell function must be gone by the next call. The directory survives through
 * the working-directory service, not through a live shell.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { toolHost } from '../fixtures/tool-host.ts'

await test('the working directory persists while shell variables and functions do not', async t => {
  const { call, workspace } = await toolHost(t)
  await mkdir(join(workspace, 'sub'), { recursive: true })

  const moved = await call('Bash', { command: 'cd sub && pwd' })
  assert.equal(moved.status, 'completed')
  assert.equal(moved.stdout.trim(), join(workspace, 'sub'))

  const stayed = await call('Bash', { command: 'pwd' })
  assert.equal(stayed.stdout.trim(), join(workspace, 'sub'), 'the next call starts where the last one ended')

  await call('Bash', { command: 'export ZCODE_PROBE=carried' })
  const env = await call('Bash', { command: 'printf "%s" "${ZCODE_PROBE-unset}"' })
  assert.equal(env.stdout, 'unset', 'exports do not survive the call')

  await call('Bash', { command: 'zcode_fixture() { printf carried; }; zcode_fixture' })
  const fn = await call('Bash', { command: 'zcode_fixture 2>/dev/null || printf missing' })
  assert.equal(fn.stdout, 'missing', 'shell functions do not survive the call')
})

await test('percent signs survive the shell wrapper', async t => {
  const { call } = await toolHost(t)
  const result = await call('Bash', { command: "printf '100%%\n'" })
  assert.equal(result.stdout, '100%\n', 'the command reaches bash unbaked')
})

await test('a truncated capture still recovers the working directory', async t => {
  const { call, workspace } = await toolHost(t)
  await mkdir(join(workspace, 'deep'), { recursive: true })
  const noisy = await call('Bash', { command: `for i in $(seq 1 4000); do printf 'line-%s-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n' "$i"; done; cd deep` })
  assert.equal(noisy.status, 'completed')
  assert.equal(noisy.stdoutTruncated, true, 'the output exceeded the capture budget')
  const after = await call('Bash', { command: 'pwd' })
  assert.equal(after.stdout.trim(), join(workspace, 'deep'), 'the marker survives a spilled capture')
})

await test('the timeout settles the call as cancelled and kills the command', async t => {
  const { call } = await toolHost(t)
  const started = Date.now()
  const result = await call('Bash', { command: 'sleep 5', timeout: 100 })
  assert.equal(result.status, 'cancelled')
  assert.equal(result.interrupted, true)
  assert.ok(Date.now() - started < 4000, 'the command did not run to completion')
})

await test('a non-zero exit is reported with its code and stderr', async t => {
  const { call } = await toolHost(t)
  const failed = await call('Bash', { command: 'printf out; printf err >&2; exit 3' })
  assert.equal(failed.status, 'failed')
  assert.equal(failed.exitCode, 3)
  assert.equal(failed.interrupted, false)
  assert.equal(failed.stdout, 'out')
  assert.equal(failed.stderr, 'err')
})

await test('Bash search mode makes grep and find available without Glob and Grep', async t => {
  const { call, workspace, stepNames } = await toolHost(t, { searchMode: 'bash' })
  const file = join(workspace, 'search.txt')
  await call('Write', { file_path: file, content: 'needle\nhay\n' })
  assert.deepEqual(await stepNames(), ['Bash', 'Edit', 'Read', 'Write'])

  const grep = await call('Bash', { command: 'grep -n needle search.txt' })
  assert.equal(grep.status, 'completed')
  assert.match(grep.stdout, /needle/u)

  const find = await call('Bash', { command: 'find . -name "search.txt"' })
  assert.match(find.stdout, /search\.txt/u)
})

await test('an aborted call settles as cancelled', async t => {
  const { host, agent } = await toolHost(t)
  const tool = host.tools.get('Bash', agent)
  const controller = new AbortController()
  const running = tool.execute({ command: 'sleep 30' }, {
    callId: 'cancel-me',
    name: 'Bash',
    arguments: {},
    signal: controller.signal,
    agent,
  })
  await new Promise(resolve => setTimeout(resolve, 150))
  controller.abort()
  const result = await running
  assert.equal(result.interrupted, true)
  assert.equal(result.status, 'cancelled')
})

await test('an empty command is refused before a process starts', async t => {
  const { call } = await toolHost(t)
  await assert.rejects(call('Bash', { command: '   ' }), /command must be non-empty/u)
})
