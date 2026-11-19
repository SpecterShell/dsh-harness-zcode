/**
 * Negative confinement proof at the tool boundary.
 *
 * A deployment that mounts a sandbox policy expects every side effect a tool
 * causes to pass through it. These cases assert the observable consequence
 * rather than the mechanism: a protected file outside the workspace keeps its
 * bytes, and a composition that cannot confine refuses to run instead of
 * falling back to an unconfined process.
 *
 * The skip branch mirrors a host without a usable enforcement mechanism
 * (bubblewrap absent, platform unsupported); the fail-closed branch is the one
 * that matters when a policy exists but confinement does not.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { toolHost } from '../fixtures/tool-host.ts'

await test('Bash cannot write a protected file under a read-only sandbox', async t => {
  const { call, root } = await toolHost(t, { sandboxMode: 'read-only' })
  const protectedFile = join(root, 'protected.txt')
  await writeFile(protectedFile, 'original')

  const result = await call('Bash', { command: `printf altered > ${JSON.stringify(protectedFile)}` })
  assert.equal(await readFile(protectedFile, 'utf8'), 'original', 'the sandbox kept the protected file intact')
  assert.match(result.stderr, /read-only|denied|permission|operation not permitted/iu, `the denial reaches the model, got ${JSON.stringify(result)}`)
  assert.equal(result.stdout, '', 'the write produced no output')
  assert.equal(result.status, 'failed', 'a denied file operation fails the call even when the shell exits 0')
})

await test('a policy without an enforcement provider leaves the row unregistered', async t => {
  // A policy is composed but nothing can enforce it: the confined shell never
  // becomes usable, so the row must not register a single tool. A deployment in
  // that state has no Bash, rather than an unconfined Bash.
  const { host, agent, root } = await toolHost(t, { sandboxMode: 'read-only', sandboxProvider: false })
  const protectedFile = join(root, 'protected.txt')
  await writeFile(protectedFile, 'original')

  assert.equal(host.get('shell'), undefined, 'no confining shell is available')
  assert.deepEqual(host.tools.schemas(agent), [], 'the tools row registered nothing')
  assert.equal(await readFile(protectedFile, 'utf8'), 'original', 'nothing ran without confinement')
})
