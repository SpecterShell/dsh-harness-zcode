/**
 * Prove the artifact a user installs, not the worktree.
 *
 * The test copies the shipping inputs to a scratch directory, packs there with
 * the package's own `prepack` hook, extracts the tarball and imports every
 * published entry point with only the declared runtime dependency present.
 * Nothing here reaches the network, and the repository's own `lib/` is never
 * touched.
 *
 * Run it with `pnpm test:pack`; it is deliberately outside `pnpm test` because
 * it compiles the package first.
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { cp, readdir, readFile, symlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { native, temporary } from '../fixtures/native-host.ts'

const run = promisify(execFile)
const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const { applyEntryPatches } = await native('cordis-plugin-include')
const { loadOverlayPatches } = await native('dsh-app-boot')

/** Shipping inputs, copied by name; `node_modules` is linked instead. */
const INPUTS = [
  'package.json',
  'tsconfig.json',
  'tsconfig.build.json',
  'tsdown.config.ts',
  'cordis.patch.yml',
  'locale',
  'README.md',
  'README.zh-Hans.md',
  'LICENSE',
  'NOTICE',
  'CHANGELOG.md',
  'src',
]

interface Manifest {
  name?: string
  exports: Record<string, string | { default?: string }>
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  files?: string[]
}

/** Run a command in a directory and fail with its combined output. */
async function exec(cwd: string, command: string, args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await run(command, args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    return stdout + stderr
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message: string }
    throw new Error(`${command} ${args.join(' ')} failed:\n${failure.stdout ?? ''}${failure.stderr ?? ''}${failure.message}`)
  }
}

await test('the packed artifact publishes every export and loads with its declared dependency', { timeout: 180_000 }, async t => {
  const root = await temporary(t)
  const work = join(root, 'package')
  const out = join(root, 'out')
  for (const input of INPUTS) {
    const source = join(repoRoot, input)
    if (!existsSync(source)) continue
    await cp(source, join(work, input), { recursive: true })
  }
  await symlink(join(repoRoot, 'node_modules'), join(work, 'node_modules'))

  await exec(work, 'pnpm', ['pack', '--pack-destination', out])
  const tarballs = (await readdir(out)).filter(name => name.endsWith('.tgz'))
  assert.equal(tarballs.length, 1, 'one tarball per pack')
  const installed = join(root, 'installed')
  await exec(root, 'mkdir', ['-p', installed])
  await exec(root, 'tar', ['-xzf', join(out, tarballs[0] as string), '-C', installed])
  const pkg = join(installed, 'package')

  const manifest = JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8')) as Manifest
  assert.equal(manifest.name, '@spectershell/dsh-harness-zcode')
  const packedPatch = join(pkg, 'cordis.patch.yml')
  const rows = applyEntryPatches([], loadOverlayPatches('zcode-packed', packedPatch))
  assert.equal(rows[0]?.id, '@spectershell/dsh-harness-zcode')
  assert.equal(rows[0]?.name, '@spectershell/dsh-harness-zcode')
  assert.deepEqual(
    rows
      .filter((row: { id?: string }) => row.id?.startsWith('preset-zcode'))
      .map((row: { id: string; config: { id: string; name: string } }) => [row.id, row.config.id, row.config.name]),
    [
      ['preset-zcode-strict', 'zcode-strict', 'ZCode strict mode'],
      ['preset-zcode', 'zcode', 'ZCode mode'],
      ['preset-zcode-ptc', 'zcode-ptc', 'ZCode PTC'],
      ['preset-zcode-creator', 'zcode-creator', 'ZCode Creator'],
    ],
    'the extracted patch registers the four exact preset identities',
  )
  // Source, tests and build inputs must never ship.
  for (const leaked of ['src', 'test', 'tsconfig.json', 'tsdown.config.ts', 'node_modules']) {
    assert.equal(existsSync(join(pkg, leaked)), false, `${leaked} leaked into the tarball`)
  }
  for (const emptyInput of ['assets', 'prompts', 'skills']) {
    assert.equal(existsSync(join(pkg, emptyInput)), false, `${emptyInput} must not ship when it has no package content`)
    assert.ok(!(manifest.files ?? []).includes(emptyInput), `${emptyInput} must not remain in package.json files`)
  }

  // Every bare import in the node-side code must be declared: `dependencies`
  // for what the package carries, `peerDependencies` for what the profile
  // provides. The client entry is a browser bundle that externalizes React and
  // runs in the web host's module loader, so it is checked separately.
  const declared = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ])
  const libFiles = (await readdir(join(pkg, 'lib'), { recursive: true }))
    .filter(name => name.endsWith('.js'))
  assert.ok(libFiles.length > 0, 'the build emitted JavaScript')
  const nodeFiles = libFiles.filter(name => !name.startsWith('client'))
  assert.ok(nodeFiles.length > 0, 'the build emitted node-side JavaScript')
  for (const file of nodeFiles) {
    const source = await readFile(join(pkg, 'lib', file), 'utf8')
    for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"\n]+)['"]/gu)) {
      const specifier = match[1] as string
      if (specifier.startsWith('node:') || specifier.startsWith('.')) continue
      const packageName = specifier.startsWith('@')
        ? specifier.split('/').slice(0, 2).join('/')
        : specifier.split('/')[0] as string
      assert.ok(declared.has(packageName), `lib/${file} imports undeclared package ${packageName}`)
    }
  }
  const clientFile = libFiles.find(name => name.startsWith('client'))
  if (clientFile !== undefined) {
    const client = await readFile(join(pkg, 'lib', clientFile), 'utf8')
    assert.match(client, /window\.__ModuleLoader__\.load/u, 'the client entry is a web-host bundle')
  }

  // Stand in for a profile: the extracted package next to the declared
  // dependencies and peers, which are the ones already installed here.
  const modules = join(pkg, 'node_modules')
  for (const dependency of declared) {
    const source = join(repoRoot, 'node_modules', dependency)
    assert.ok(existsSync(source), `${dependency} must be installed in the worktree before packing`)
    await exec(root, 'mkdir', ['-p', join(modules, dirname(dependency))])
    await symlink(source, join(modules, dependency))
  }
  for (const [subpath, target] of Object.entries(manifest.exports)) {
    const file = typeof target === 'string' ? target : target.default
    if (file === undefined || !file.endsWith('.js')) continue
    // The browser entry only runs inside the web host's module loader.
    if (subpath === './client') continue
    assert.ok(existsSync(join(pkg, file)), `export ${subpath} points at ${file}, which is not in the tarball`)
    const loaded = await import(pathToFileURL(join(pkg, file)).href) as Record<string, unknown>
    assert.ok(Object.keys(loaded).length > 0, `export ${subpath} loaded nothing`)
    t.diagnostic(`${subpath} -> ${relative(pkg, join(pkg, file))} (${Object.keys(loaded).length} exports)`)
  }
  // The patch file is how the bundle is discovered; it has to ship.
  if (existsSync(join(repoRoot, 'cordis.patch.yml'))) {
    assert.ok(existsSync(packedPatch), 'cordis.patch.yml must be in the tarball')
  }
})
