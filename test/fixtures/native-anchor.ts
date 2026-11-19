/**
 * Locate and validate the installed DeepSeek Harness used by native tests.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'

/** The host version these proofs are written against. */
export const HOST_VERSION = '0.2.2-rc.3'

/**
 * Find the installed host manifest from `DSH_NATIVE_ANCHOR` or the `dsh` command.
 */
export function installedHostAnchor(): string {
  const anchor = findInstalledHostAnchor()
  assert.ok(
    anchor !== undefined,
    'no installed host found: put `dsh` on PATH or set DSH_NATIVE_ANCHOR to its package.json',
  )
  assert.ok(
    isAbsolute(anchor),
    'DSH_NATIVE_ANCHOR must be an absolute path to the installed @deepseek-ai/dsh/package.json',
  )
  const manifest = JSON.parse(readFileSync(anchor, 'utf8')) as {
    name?: unknown
    version?: unknown
  }
  assert.equal(
    manifest.name,
    '@deepseek-ai/dsh',
    'DSH_NATIVE_ANCHOR must name the @deepseek-ai/dsh manifest',
  )
  assert.equal(
    manifest.version,
    HOST_VERSION,
    `these proofs are written against host ${HOST_VERSION}; the installed host is ${String(manifest.version)}`,
  )
  return anchor
}

function findInstalledHostAnchor(): string | undefined {
  const explicit = process.env.DSH_NATIVE_ANCHOR
  if (explicit !== undefined && explicit !== '') return explicit
  try {
    const executable = execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim()
    const shim = readFileSync(executable, 'utf8')
    const target = /cmd-shim-target=(\S+)\/lib\/bin\.js/.exec(shim)?.[1]
    if (target !== undefined) return join(target, 'package.json')

    for (let directory = dirname(realpathSync(executable)); ; directory = dirname(directory)) {
      const manifest = join(directory, 'package.json')
      try {
        const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown }
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
