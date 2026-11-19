#!/usr/bin/env node
/**
 * Check relative links in repository Markdown.
 *
 * External URLs and fragments are outside this local check. Generated output,
 * dependencies, and evaluation fixtures are skipped.
 */
import { readdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const skip = new Set([
  '.git',
  'node_modules',
  'lib',
  'dist',
  'coverage',
  '.patchright-cli',
  'prompts',
  'eval',
])
const skipPaths = new Set([])
const linkPattern = /!?\[[^\]]*\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+["'][^"']*["'])?\s*\)/g

async function markdownFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    const relative = path.slice(root.length).replaceAll('\\', '/')
    if (entry.isDirectory()) {
      if (skip.has(entry.name) || skipPaths.has(relative)) continue
      files.push(...await markdownFiles(path))
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      files.push(path)
    }
  }
  return files
}

const broken = []
let checked = 0

for (const file of await markdownFiles(root)) {
  let text = await readFile(file, 'utf8')
  // Preserve line counts while ignoring examples inside fenced and inline code.
  text = text
    .replace(/^```[\s\S]*?^```/gm, match => '\n'.repeat(match.split('\n').length - 1))
    .replace(/^~~~[\s\S]*?^~~~/gm, match => '\n'.repeat(match.split('\n').length - 1))
    .replace(/`[^`\n]*`/g, '')

  for (const match of text.matchAll(linkPattern)) {
    let target = match[1].trim()
    if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1)
    if (!target || target.startsWith('#') || target.startsWith('/')) continue
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue

    const pathPart = target.replace(/[?#].*$/, '')
    if (!pathPart) continue

    let decoded = pathPart
    try {
      decoded = decodeURIComponent(pathPart)
    } catch {
      // Keep the raw path; the existence check below decides.
    }

    checked += 1
    if (!existsSync(resolve(dirname(file), decoded))) {
      const line = text.slice(0, match.index).split('\n').length
      broken.push(`${file.slice(root.length)}:${line} -> ${target}`)
    }
  }
}

if (broken.length > 0) {
  console.error(`Broken relative links:\n${broken.join('\n')}`)
  process.exit(1)
}

console.log(`Checked ${checked} relative links in Markdown; all resolve.`)
