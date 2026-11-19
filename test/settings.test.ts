/**
 * Prove the settings surface the preset rows read: the host Config, the live
 * `zcodeSettings` service it provides, and the parsing the surface row uses.
 *
 * Everything mounts through a real Cordis Context, so service provisioning and
 * plugin updates behave as they do in a profile. No settings document is read
 * from disk and no profile is touched.
 *
 * The field list is read from the schema rather than written here, so adding a
 * setting does not silently escape these checks.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { native } from './fixtures/native-host.ts'
import * as hostPlugin from '../src/host.ts'
import { createZcodeSettings, defaults, parseToolNames } from '../src/config.ts'
import type { ZcodeSettingsService, ZcodeSettingsSource } from '../src/config.ts'

const { Context } = await native('cordis')

/**
 * Build a settings source from the shipped defaults, with a setter per field.
 * @param overrides - field values to replace before wrapping.
 */
function liveSource(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = { ...defaults, ...overrides }
  const fields: Record<string, { get(): unknown; set(next: unknown): void }> = {}
  for (const [name, initial] of Object.entries(values)) {
    let value = initial
    fields[name] = { get: () => value, set: next => { value = next } }
  }
  const set = (name: string, next: unknown): void => {
    assert.ok(fields[name], `no settings field named ${name}`)
    fields[name].set(next)
  }
  return { source: fields as unknown as ZcodeSettingsSource, set }
}

await test('the host Config resolves the row defaults', () => {
  const config = hostPlugin.Config({}, {}) as hostPlugin.ZcodeVolatileConfig
  assert.equal(config.searchMode.get(), 'bash', 'search rides Bash unless the fallback is asked for')
  assert.equal(config.surfaceAllow.get(), '')
  assert.equal(config.headless.get(), false)
  assert.equal(config.memoryEnabled.get(), true)
})

await test('every Config field is volatile, so the settings form can change it live', () => {
  const json = hostPlugin.Config.toJSON() as unknown as {
    uid: number
    refs: Record<number, { dict?: Record<string, number>; meta?: { volatile?: boolean } }>
  }
  const root = json.refs[json.uid]
  const fields = Object.keys(root?.dict ?? {})
  assert.ok(fields.length > 0, 'the schema has fields')
  for (const field of fields) {
    const node = json.refs[root?.dict?.[field] ?? -1]
    assert.equal(node?.meta?.volatile, true, `${field} must be volatile, or a saved value never reaches the preset`)
  }
})

await test('the zcodeSettings service reads the volatile fields on every call', () => {
  const { source, set } = liveSource()
  const service: ZcodeSettingsService = createZcodeSettings(source)
  assert.deepEqual(service.tools(), { searchMode: 'bash', preserveRunCode: true })
  assert.equal(service.context().compactionEnabled, true)
  assert.deepEqual(service.surfaceAllow(), [])

  set('searchMode', 'tools')
  set('surfaceAllow', 'bash  read,glob,bash')
  set('compactionEnabled', false)
  assert.deepEqual(service.tools(), { searchMode: 'tools', preserveRunCode: true })
  assert.equal(service.context().compactionEnabled, false)
  assert.deepEqual(service.surfaceAllow(), ['bash', 'read', 'glob'])
})

await test('headless turns memory extraction off without rewriting the stored field', () => {
  const { source, set } = liveSource({ memoryExtractionEnabled: true, headless: false })
  const service = createZcodeSettings(source)
  assert.equal(service.context().memoryExtractionEnabled, true)

  set('headless', true)
  assert.equal(service.context().memoryExtractionEnabled, false, 'a headless run never extracts memory')

  set('headless', false)
  assert.equal(service.context().memoryExtractionEnabled, true, 'the stored value is still there')
})

await test('the host plugin provides zcodeSettings from its resolved Config', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const fiber = ctx.plugin(hostPlugin, {})
  await fiber.await()
  const first = ctx.get('zcodeSettings') as ZcodeSettingsService
  assert.ok(first, 'the host row provides the service')
  assert.deepEqual(first.tools(), { searchMode: 'bash', preserveRunCode: true })
  assert.equal(first.context().compactionEnabled, true)

  await fiber.update({ searchMode: 'tools', compactionEnabled: false })
  const second = ctx.get('zcodeSettings') as ZcodeSettingsService
  assert.deepEqual(second.tools(), { searchMode: 'tools', preserveRunCode: true })
  assert.equal(second.context().compactionEnabled, false)
})

await test('tool-name text parses into a deduplicated list', () => {
  assert.deepEqual(parseToolNames(''), [])
  assert.deepEqual(parseToolNames('  ,\n\t '), [])
  assert.deepEqual(parseToolNames('read, edit  bash\nread'), ['read', 'edit', 'bash'])
  assert.deepEqual(parseToolNames('mcp__demo__search'), ['mcp__demo__search'])
})
