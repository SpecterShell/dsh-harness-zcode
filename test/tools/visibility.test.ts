/**
 * Prove which ZCode tools a model step can call.
 *
 * Glob and Grep are conditional registrations, so a raw registry listing is
 * not evidence: the test resolves one step's admission and reads that step's
 * tool set, which is what the model receives.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { toolHost } from '../fixtures/tool-host.ts'

const CORE = ['Bash', 'Edit', 'Read', 'Write']
const SEARCH = ['Glob', 'Grep']

await test('Bash search mode hides Glob and Grep while the core four stay callable', async t => {
  const { host, agent, stepNames } = await toolHost(t, { searchMode: 'bash' })
  assert.deepEqual(await stepNames(), CORE, 'search rides Bash, so no fallback tool reaches the step')
  assert.ok(host.tools.get('Glob', agent), 'the fallback stays registered, only excluded from the step')
  assert.equal(host.tools.executable('Glob', agent), undefined, 'a call outside a step cannot reach a conditional tool')
})

await test('tools search mode admits Glob and Grep', async t => {
  const { stepNames } = await toolHost(t, { searchMode: 'tools' })
  assert.deepEqual(await stepNames(), [...CORE, ...SEARCH].sort())
})

await test('a settings change applies to the next resolved step', async t => {
  const { stepNames, setSearchMode } = await toolHost(t, { searchMode: 'bash' })
  assert.deepEqual(await stepNames(), CORE)

  setSearchMode('tools')
  assert.deepEqual(await stepNames(), [...CORE, ...SEARCH].sort(), 'each step re-reads the setting')

  setSearchMode('bash')
  assert.deepEqual(await stepNames(), CORE)
})
