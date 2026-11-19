/**
 * Prove the pinned ZCode instruction discovery: the default candidate list is
 * `AGENTS.md`, the optional user file `~/.zcode/AGENTS.md` precedes the
 * workspace file, the workspace lookup returns the nearest file walked up from
 * the working directory and stops at the project root, and the byte budget cuts
 * on a UTF-8 character boundary.
 *
 * Source: ZCode `adapters/src/context/index.ts` at fec9759,
 * DEFAULT_PRIORITY_FILES, DEFAULT_MAX_BYTES and findInstructionFile.
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  DEFAULT_INSTRUCTION_CANDIDATES,
  INSTRUCTION_BUDGET_BYTES,
  discoverInstructions,
  renderInstructionAnnouncement,
  renderInstructionRefresh,
} from '../../src/context/instructions.ts'

async function workspace(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'zcode-instructions-'))
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })
  return root
}

async function put(path: string, text: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, text, 'utf8')
}

test('defaults match the pinned upstream values', () => {
  assert.deepEqual([...DEFAULT_INSTRUCTION_CANDIDATES], ['AGENTS.md'])
  assert.equal(INSTRUCTION_BUDGET_BYTES, 100 * 1024)
})

test('the user file precedes the workspace file', async (t) => {
  const root = await workspace(t)
  const project = join(root, 'project')
  const userHome = join(root, 'home')
  await put(join(userHome, '.zcode', 'AGENTS.md'), 'user rule')
  await put(join(project, 'AGENTS.md'), 'workspace rule')

  const sources = await discoverInstructions({ cwd: project, projectRoot: project, userHome })
  assert.deepEqual(
    sources.map((source) => source.scope),
    ['user', 'workspace'],
  )
  assert.deepEqual(
    sources.map((source) => source.text),
    ['user rule', 'workspace rule'],
  )
})

test('the nearest workspace file wins instead of accumulating parent files', async (t) => {
  const root = await workspace(t)
  const project = join(root, 'project')
  await put(join(project, 'AGENTS.md'), 'outer rule')
  await put(join(project, 'pkg', 'AGENTS.md'), 'inner rule')

  const sources = await discoverInstructions({
    cwd: join(project, 'pkg'),
    projectRoot: project,
    userHome: join(root, 'empty-home'),
  })
  assert.equal(sources.length, 1)
  assert.equal(sources[0]?.text, 'inner rule')
  assert.equal(sources[0]?.scope, 'workspace')
})

test('the walk stops at the project root', async (t) => {
  const root = await workspace(t)
  const project = join(root, 'project')
  await put(join(root, 'AGENTS.md'), 'outside rule')
  await mkdir(join(project, 'pkg'), { recursive: true })

  const sources = await discoverInstructions({
    cwd: join(project, 'pkg'),
    projectRoot: project,
    userHome: join(root, 'empty-home'),
  })
  assert.deepEqual(sources, [])
})

test('a custom candidate list keeps its own order at one directory', async (t) => {
  const root = await workspace(t)
  const project = join(root, 'project')
  await put(join(project, 'CLAUDE.md'), 'claude rule')
  await put(join(project, 'AGENTS.md'), 'agents rule')

  const sources = await discoverInstructions({
    cwd: project,
    projectRoot: project,
    userHome: join(root, 'empty-home'),
    candidateFileNames: ['CLAUDE.md', 'AGENTS.md'],
  })
  assert.equal(sources.length, 1)
  assert.equal(sources[0]?.text, 'claude rule')
})

test('the user file is skipped when AGENTS.md is not a candidate', async (t) => {
  const root = await workspace(t)
  const project = join(root, 'project')
  const userHome = join(root, 'home')
  await put(join(userHome, '.zcode', 'AGENTS.md'), 'user rule')
  await put(join(project, 'CLAUDE.md'), 'claude rule')

  const sources = await discoverInstructions({
    cwd: project,
    projectRoot: project,
    userHome,
    candidateFileNames: ['CLAUDE.md'],
  })
  assert.deepEqual(
    sources.map((source) => source.text),
    ['claude rule'],
  )
})

test('the byte budget cuts on a character boundary and reports truncation', async (t) => {
  const root = await workspace(t)
  const project = join(root, 'project')
  // Ten ASCII bytes, then a three-byte character that straddles a 12-byte budget.
  await put(join(project, 'AGENTS.md'), `${'a'.repeat(10)}中${'b'.repeat(10)}`)

  const sources = await discoverInstructions({
    cwd: project,
    projectRoot: project,
    userHome: join(root, 'empty-home'),
    budgetBytes: 12,
  })
  assert.equal(sources[0]?.text, 'a'.repeat(10))
  assert.equal(sources[0]?.truncated, true)
  assert.equal(sources[0]?.bytesRead, 10)
})

test('the announcement names both scopes and keeps the override warning', async (t) => {
  const root = await workspace(t)
  const project = join(root, 'project')
  const userHome = join(root, 'home')
  await put(join(userHome, '.zcode', 'AGENTS.md'), 'user rule')
  await put(join(project, 'AGENTS.md'), 'workspace rule')
  const sources = await discoverInstructions({ cwd: project, projectRoot: project, userHome })

  const text = renderInstructionAnnouncement(sources)
  assert.match(text, /OVERRIDE/)
  assert.match(text, /user's private global instructions/)
  assert.match(text, /project instructions, checked into the codebase/)
})

test('a refresh carries changed files only and names removed ones', async (t) => {
  const root = await workspace(t)
  const project = join(root, 'project')
  await put(join(project, 'AGENTS.md'), 'new rule')
  const sources = await discoverInstructions({
    cwd: project,
    projectRoot: project,
    userHome: join(root, 'empty-home'),
  })

  const text = renderInstructionRefresh(sources, ['/repo/old/AGENTS.md'])
  assert.match(text, /new rule/)
  assert.match(text, /no longer present: \/repo\/old\/AGENTS\.md/)
})
