/**
 * Prove the mask rules the surface row applies to inherited tool names.
 *
 * The row only ever talks to `ctx.tools.view()`, `restrict()` and two events,
 * so a recording double stands in for the registry here. The proof that the
 * mask follows a real Agent binding lives in `test/integration/preset.test.ts`;
 * this file is about the rules and their triggers.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { native } from './fixtures/native-host.ts'
import type { HostValue } from './fixtures/native-host.ts'
import * as surface from '../src/surface.ts'
import { parseToolNames } from '../src/config.ts'

const { Context } = await native('cordis')

/** Mount a provider without a row file; the test keeps the value it provides. */
async function provide(ctx: HostValue, name: string, value: unknown): Promise<void> {
  const fiber = ctx.plugin({
    name: `fixture-${name}`,
    apply(pluginCtx: HostValue) { pluginCtx.provide(name, value) },
  })
  await fiber.await()
}

/**
 * A tool registry double with the two behaviors the row depends on: `restrict`
 * emits `tools/change` like the real layer does, and its disposer removes the
 * layer.
 */
function registry(names: string[], emit: () => void) {
  const known = new Set(names)
  const installed: string[][] = []
  let active: string[] | undefined
  const tools = {
    view: () => ({ restrictableNames: known }),
    restrict: (filter: { deny: readonly string[] }) => {
      active = [...filter.deny]
      installed.push(active)
      // The real service emits synchronously from `restrict`.
      queueMicrotask(emit)
      return () => { active = undefined }
    },
  }
  return { tools, installed, active: () => active }
}

await test('the mask hides every inherited name the row does not allow', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const fake = registry(['bash', 'read', 'web_search'], () => ctx.emit('tools/change'))
  await provide(ctx, 'tools', fake.tools)
  await ctx.plugin(surface, { allow: ['bash', 'read'] }).await()
  assert.deepEqual(fake.active(), ['web_search'])
})

await test('the settings allow list merges with the row list and re-syncs', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const fake = registry(['bash', 'read', 'glob', 'web_search'], () => ctx.emit('tools/change'))
  await provide(ctx, 'tools', fake.tools)
  let allowText = ''
  await provide(ctx, 'zcodeSettings', { surfaceAllow: () => parseToolNames(allowText) })
  await ctx.plugin(surface, { allow: ['bash'] }).await()
  assert.deepEqual(fake.active(), ['glob', 'read', 'web_search'])

  allowText = 'read, glob'
  ctx.emit('settings/document-updated')
  assert.deepEqual(fake.active(), ['web_search'])
})

await test('a host tool registered later joins the mask through tools/change', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const fake = registry(['bash'], () => ctx.emit('tools/change'))
  await provide(ctx, 'tools', fake.tools)
  await ctx.plugin(surface, { allow: ['bash'] }).await()
  assert.equal(fake.active(), undefined, 'nothing to hide means no layer at all')

  ;(fake.tools.view().restrictableNames as Set<string>).add('mcp__demo__search')
  ctx.emit('tools/change')
  assert.deepEqual(fake.active(), ['mcp__demo__search'])
})

await test('a deny-only surface keeps unrelated inherited tools', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const fake = registry(['bash', 'read', 'web_search', 'mcp__demo__search'], () => ctx.emit('tools/change'))
  await provide(ctx, 'tools', fake.tools)
  await ctx.plugin(surface, {
    deny: ['bash', 'read', 'glob', 'grep'],
    allow: ['read'],
  }).await()
  assert.deepEqual(fake.active(), ['bash'])

  ;(fake.tools.view().restrictableNames as Set<string>).add('grep')
  ctx.emit('tools/change')
  assert.deepEqual(fake.active(), ['bash', 'grep'])
})

await test('an unchanged mask is not reinstalled and an empty mask installs nothing', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const fake = registry(['bash'], () => ctx.emit('tools/change'))
  await provide(ctx, 'tools', fake.tools)
  await ctx.plugin(surface, { allow: ['bash', 'read'] }).await()
  const calls = fake.installed.length
  // The registry echo of an install must not reinstall; otherwise the row and
  // the registry ping-pong on every change.
  await new Promise<void>(resolve => queueMicrotask(resolve))
  ctx.emit('tools/change')
  ctx.emit('settings/document-updated')
  assert.equal(fake.installed.length, calls, 'no reinstall when the deny set did not change')

  const permissive = registry(['bash'], () => other.emit('tools/change'))
  const other = new Context()
  t.after(() => other.fiber.dispose())
  await provide(other, 'tools', permissive.tools)
  await other.plugin(surface, { allow: ['bash'] }).await()
  assert.deepEqual(permissive.installed, [], 'an empty deny list adds no layer')
})

await test('an invalid allow config fails at mount', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const fake = registry(['bash'], () => ctx.emit('tools/change'))
  await provide(ctx, 'tools', fake.tools)
  await assert.rejects(
    ctx.plugin(surface, { allow: 'bash' }).await(),
    /zcode-surface: allow must be an array of tool names/u,
  )
  await assert.rejects(
    ctx.plugin(surface, { deny: 'bash' }).await(),
    /zcode-surface: deny must be an array of tool names/u,
  )
})
