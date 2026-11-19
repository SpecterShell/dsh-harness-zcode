/**
 * Prove the surface mask against the real tool registry and real scope chain.
 *
 * The preset scope owns the restriction, the Agent scope inherits it through
 * its parent link, and `ToolsService.view(scope)` composes the two. Nothing is
 * stubbed except the `zcodeSettings` service, because a settings document is
 * not what this file is about.
 *
 * The switch case reproduces what a blank-session preset change does: re-link
 * the Agent scope's parent (`bindScopeParent`, the call `recompose()` makes)
 * and read the same scope again.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { native, mount } from '../fixtures/native-host.ts'
import type { HostValue } from '../fixtures/native-host.ts'
import { parseToolNames } from '../../src/config.ts'
import * as surface from '../../src/surface.ts'

const { Context } = await native('cordis')
const { SystemPrompt } = await native('dsh-system-prompt')
const { ToolsService } = await native('dsh-tools')
const { createScope, scopeOf, bindScopeParent, scopeParentOf } = await native('dsh-scope')

/** A direct registry definition that returns its own value and renders it. */
function definition(name: string) {
  return {
    name,
    description: `${name} fixture`,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'string' },
      render: (_context: unknown, result: string) => [{ type: 'text', text: result }],
    },
    execute: async (): Promise<string> => name,
  }
}

const HOST_TOOLS = ['bash', 'edit', 'glob', 'grep', 'read', 'web_search', 'write']

/** Compose the registry, the host tools and one settings service. */
async function compose(t: HostValue) {
  const host = new Context()
  t.after(() => host.fiber.dispose())
  await mount(host, SystemPrompt)
  await mount(host, ToolsService)
  for (const name of HOST_TOOLS) host.tools.register(definition(name))
  let allowText = ''
  await mount(host, {
    name: 'fixture-zcode-settings',
    apply(ctx: HostValue) {
      ctx.provide('zcodeSettings', { surfaceAllow: () => parseToolNames(allowText) })
    },
  })
  return {
    host,
    setAllow: (text: string) => { allowText = text },
    names: (scope?: object) => host.tools.schemas(scope).map((tool: HostValue) => tool.name).sort(),
  }
}

/**
 * Mint a scope inside a plugin that declares the `tools` dependency, because a
 * scoped context inherits the dependency API of the plugin that mints it.
 * @param ctx - context to mint under.
 * @param key - opaque scope identity the test keeps.
 * @param setup - registrations to make through the scoped context.
 * @param parent - optional enclosing scope key.
 */
async function scope(ctx: HostValue, key: object, setup?: (scoped: HostValue) => void, parent?: object) {
  let scoped: HostValue
  const fiber = await mount(ctx, {
    name: 'fixture-scope',
    inject: ['tools'],
    async apply(pluginCtx: HostValue) {
      const minted = parent === undefined ? createScope(pluginCtx, key) : createScope(pluginCtx, key, { parent })
      await minted.ctx.fiber.await()
      scoped = minted.ctx
      setup?.(minted.ctx)
    },
  })
  return { key, ctx: scoped!, dispose: () => fiber.dispose() }
}

await test('a preset-scope mask follows the Agent parent link through mount, settings and late tools', async t => {
  const { host, setAllow, names } = await compose(t)
  assert.deepEqual(names(undefined), HOST_TOOLS, 'the deployment starts with its own tools')

  const presetKey = {}
  // The preset registers its own dedicated tools; `read` and `bash` deliberately
  // share a host name, so a shadowed name must still resolve to the scoped row.
  const preset = await scope(host, presetKey, scoped => {
    for (const name of ['read', 'bash', 'edit']) scoped.tools.register(definition(name))
  })
  const surfaceFiber = await mount(preset.ctx, surface, { allow: ['read', 'bash', 'edit'] })

  const agentKey = {}
  const agent = await scope(host, agentKey)
  assert.equal(scopeOf(agent.ctx), agentKey)
  assert.deepEqual(names(agentKey), HOST_TOOLS, 'an unbound Agent keeps every host tool')

  bindScopeParent(agentKey, presetKey)
  assert.equal(scopeParentOf(agentKey), presetKey)
  assert.deepEqual(
    names(agentKey),
    ['bash', 'edit', 'read'],
    'the bound Agent sees the preset tools only; the host tools are masked',
  )
  assert.equal(host.tools.get('web_search', agentKey), undefined)

  setAllow('web_search')
  host.emit('settings/document-updated')
  assert.deepEqual(names(agentKey), ['bash', 'edit', 'read', 'web_search'], 'a saved allow list reaches a live Agent')

  host.tools.register(definition('mcp__demo__search'))
  assert.equal(host.tools.get('mcp__demo__search', agentKey), undefined, 'a late host tool stays hidden')
  assert.deepEqual(names(undefined), [...HOST_TOOLS, 'mcp__demo__search'].sort(), 'the deployment view is unchanged')

  await surfaceFiber.dispose()
  assert.deepEqual(names(agentKey), [...HOST_TOOLS, 'mcp__demo__search'].sort(), 'unloading the row lifts its layer; the preset rows still shadow the host names')
})

await test('a preset switch re-links the same Agent scope and the mask follows it', async t => {
  const { host, names } = await compose(t)
  const zcodeKey = {}
  const zcode = await scope(host, zcodeKey, scoped => { scoped.tools.register(definition('read')) })
  const zcodeSurface = await mount(zcode.ctx, surface, { allow: ['read'] })

  const plainKey = {}
  const plain = await scope(host, plainKey, scoped => { scoped.tools.register(definition('plain_tool')) })

  const agentKey = {}
  const agent = await scope(host, agentKey)
  assert.equal(scopeOf(agent.ctx), agentKey)
  const binding = bindScopeParent(agentKey, plainKey)
  assert.deepEqual(names(agentKey), [...HOST_TOOLS, 'plain_tool'].sort(), 'the plain preset keeps the host tools')

  // `recompose()` re-links through the binding the original bind returned.
  binding.rebind(zcodeKey)
  assert.deepEqual(names(agentKey), ['read'], 'the ZCode preset masks the host tools and keeps its own row')

  binding.rebind(plainKey)
  assert.deepEqual(names(agentKey), [...HOST_TOOLS, 'plain_tool'].sort(), 'switching away restores the host tools')

  await zcodeSurface.dispose()
  await zcode.dispose()
  assert.deepEqual(names(undefined), HOST_TOOLS, 'preset disposal leaves the deployment tools in place')
  assert.deepEqual(names(agentKey), [...HOST_TOOLS, 'plain_tool'].sort(), 'the Agent scope keeps inheriting from its current parent')
})
