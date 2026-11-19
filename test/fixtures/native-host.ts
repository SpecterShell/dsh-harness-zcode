/**
 * The one place this repository finds the installed DeepSeek Harness.
 *
 * Tests must share Cordis, scope and session identities with the host that will
 * load this package, so they mount the host's public entry points from the
 * external installation instead of installing a second dependency graph here.
 * Nothing in this fixture starts a profile, reads user settings, opens a socket
 * or reaches the network.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import type { TestContext } from 'node:test'

/** A host-owned value (context, session, service, tool). */
export type HostValue = any

/** A host package namespace, typed by the host and not by this package. */
export type NativeModule = Record<string, any>

/** A mounted plugin fiber owned by the calling test context. */
export interface HostFiber {
  await(): Promise<void>
  dispose(): void | Promise<void>
}

/** The Cordis context members these fixtures mount a plugin through. */
export interface MountableContext {
  plugin(plugin: unknown, config?: unknown): HostFiber
}

/** The host version these proofs are written against. */
export const HOST_VERSION = '0.2.2-rc.3'

/**
 * Find the installed host manifest from the `dsh` command.
 *
 * `DSH_NATIVE_ANCHOR` wins, so a CI image can point at a checkout or a packed
 * install without a `dsh` on `PATH`. A pnpm shim records the exact entry it
 * launches as `cmd-shim-target=<dir>/lib/bin.js`; an npm global install
 * exposes `dsh` as a symlink, so the manifest is found by resolving the link
 * and walking up to the owning `package.json`.
 */
async function installedAnchor(): Promise<string | undefined> {
  const explicit = process.env.DSH_NATIVE_ANCHOR
  if (explicit !== undefined && explicit !== '') return explicit
  try {
    const executable = execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim()
    const shim = await readFile(executable, 'utf8')
    const target = /cmd-shim-target=(\S+)\/lib\/bin\.js/.exec(shim)?.[1]
    if (target !== undefined) return join(target, 'package.json')

    for (let directory = dirname(await realpath(executable)); ; directory = dirname(directory)) {
      const manifest = join(directory, 'package.json')
      try {
        const parsed = JSON.parse(await readFile(manifest, 'utf8')) as { name?: unknown }
        if (parsed.name === '@deepseek-ai/dsh') return manifest
      } catch {
        // Not this directory's manifest; keep walking toward the install root.
      }
      if (dirname(directory) === directory) return undefined
    }
  } catch {
    return undefined
  }
}

const anchor = await installedAnchor()
assert.ok(anchor !== undefined, 'no installed host found: put `dsh` on PATH or set DSH_NATIVE_ANCHOR to its package.json')
assert.ok(isAbsolute(anchor), 'DSH_NATIVE_ANCHOR must be an absolute path to the installed @deepseek-ai/dsh/package.json')
const hostManifest = JSON.parse(await readFile(anchor, 'utf8')) as { name?: unknown; version?: unknown }
assert.equal(hostManifest.name, '@deepseek-ai/dsh', 'DSH_NATIVE_ANCHOR must name the @deepseek-ai/dsh manifest')
assert.equal(
  hostManifest.version,
  HOST_VERSION,
  `these proofs are written against host ${HOST_VERSION}; the installed host is ${String(hostManifest.version)}`,
)

const require = createRequire(anchor)

/**
 * Import one public host entry.
 * @param name - package name without the `@deepseek-ai/` prefix.
 * @returns the package namespace.
 */
export async function native(name: string): Promise<NativeModule> {
  return import(require.resolve(`@deepseek-ai/${name}`))
}

/** Capture exact package provenance for a failure report instead of guessing versions. */
export async function provenance(names: string[]): Promise<Array<{ name: string; version: string; manifestPath: string }>> {
  return Promise.all(names.map(async name => {
    const manifestPath = await realpath(require.resolve(`@deepseek-ai/${name}/package.json`))
    const { version } = JSON.parse(await readFile(manifestPath, 'utf8')) as { version: string }
    return { name: `@deepseek-ai/${name}`, version, manifestPath }
  }))
}

/**
 * Mount and await a host plugin. Teardown stays with the root fiber that the
 * calling test disposes.
 * @param ctx - the context to mount on.
 * @param plugin - the plugin value.
 * @param config - optional row config.
 */
export async function mount(ctx: MountableContext, plugin: unknown, config?: unknown): Promise<HostFiber> {
  const fiber = ctx.plugin(plugin, config)
  await fiber.await()
  return fiber
}

/**
 * Own a unique temporary root and check its identity before recursive cleanup.
 * @param t - the calling test, which disposes the directory.
 */
export async function temporary(t: TestContext): Promise<string> {
  const parent = await realpath(tmpdir())
  const path = await mkdtemp(join(parent, 'zcode-proof-'))
  t.after(async () => {
    assert.equal(dirname(path), parent, 'refusing to remove a directory that left the temp root')
    assert.equal(await realpath(path), path, 'refusing to remove a directory that was replaced by a link')
    await rm(path, { recursive: true })
  })
  return path
}

/**
 * Own an isolated profile root for tests that read or write settings.
 *
 * The returned environment redirects `DSH_HOME` and `HOME` at the temporary
 * root, so a test that spawns a host process cannot see or modify the real
 * profile. Values are returned rather than assigned: the caller decides
 * whether its host reads them.
 * @param t - the calling test, which disposes the directory.
 */
export async function isolatedHome(t: TestContext): Promise<{ root: string; home: string; env: Record<string, string> }> {
  const root = await temporary(t)
  const home = join(root, 'home')
  const dshHome = join(root, 'dsh-home')
  await mkdir(home, { recursive: true })
  await mkdir(dshHome, { recursive: true })
  return { root, home: dshHome, env: { HOME: home, DSH_HOME: dshHome } }
}
