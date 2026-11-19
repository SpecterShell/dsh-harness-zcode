/**
 * Capitalized ZCode tool views.
 *
 * The public Slots service cannot look up or alias an occupied keyed entry, so
 * these adapters use the same public disclosure and card primitives as the
 * native lowercase views while normalizing the ZCode wire and result shapes.
 * @module
 */
import { createElement as h } from 'react'
import type { ReactNode } from 'react'
import {
  DiffBlock,
  DisclosureRow,
  IconApiOutlineRegular,
  IconBrowseOutlineRegular,
  IconEditOutlineRegular,
  IconInspectOutlineRegular,
  IconSearchOutlineRegular,
  ReadBlock,
  SearchBlock,
  TerminalBlock,
  diffTotals,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ClientSlotsLike } from './client-settings.js'

type ToolName = 'Bash' | 'Read' | 'Write' | 'Edit' | 'Glob' | 'Grep'
type RowState = 'preparing' | 'running' | 'ok' | 'error' | 'stopped'
type Translate = (key: string, values?: Record<string, string | number>) => string
type JsonObject = Record<string, unknown>

interface LazyArgs {
  has(key: string): boolean
  complete(key: string): boolean
  text(key: string): string | undefined
}

interface ResultBlock {
  call?: { argsRaw?: string } | null
  content?: readonly unknown[]
  isError?: boolean
  error?: { name?: string; code?: string; reason?: string }
  meta?: unknown
}

interface ToolviewProps {
  phase: 'preparing' | 'start' | 'result'
  block: {
    args?: LazyArgs
    argsRaw?: string
  } & ResultBlock
  toolName: string
  useDisclosure: () => { expanded: boolean; toggle: () => void }
  openFile: (path: string, options?: { line?: number }) => void
  inspect?: () => void
  t: Translate
}

interface DiffHunk {
  path: string
  oldText: string | null
  newText: string
}

interface MutationMeta {
  path: string
  diffs: DiffHunk[]
}

interface ReadMeta {
  path: string
  offset: number
  lines: Array<{ number: number; text: string }>
  totalLines: number
  lang?: string
}

type SearchMeta =
  | { kind: 'paths'; paths: string[]; truncated: boolean; total: number }
  | {
    kind: 'matches'
    files: Array<{ path: string; matches: Array<{ lineNumber: number; line: string }> }>
    truncated: boolean
    total: number
  }

interface BashMeta {
  cwd: string
  status: 'completed' | 'failed' | 'cancelled' | 'spawn_error'
  exitCode: number | null
  signal: string | null
  interrupted: boolean
}

interface ExitStatus {
  exitCode?: number | null
  signal?: string
}

interface ViewModel {
  name: ToolName
  state: RowState
  title: string
  summary: string
  path?: string
  line?: number
  output?: string
  terminal?: {
    command: string
    cwd?: string
    output?: string
    exitCode?: number | null
    signal?: string
    running: boolean
  }
  diffs?: DiffHunk[]
  read?: ReadMeta
  search?: SearchMeta
  exitStatus?: ExitStatus
}

const TOOLS: readonly ToolName[] = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep']

const STYLE = `
.dsh-zcode-tool { display:flex; flex-direction:column; }
.dsh-zcode-tool-title { font-weight:400; }
.dsh-zcode-tool-summary { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:var(--dsh-content-font-size-secondary,13px); line-height:calc(24px + var(--dsh-content-font-delta,0px)); }
.dsh-zcode-tool[data-state='error'] .dsh-zcode-tool-summary { color:var(--dsw-alias-state-error-primary); }
.dsh-zcode-tool[data-state='stopped'] .dsh-zcode-tool-summary { color:var(--dsw-alias-state-warn-label); }
.dsh-zcode-tool-dot { flex:none; width:2px; height:2px; border-radius:1px; margin:0 8px; background:var(--dsw-alias-label-caption); }
.dsh-zcode-tool-path { flex:0 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; padding:0; border:0; background:none; color:inherit; font:inherit; text-decoration:underline dotted; text-underline-offset:3px; cursor:pointer; }
.dsh-zcode-tool-badge { flex:none; display:inline-flex; align-items:center; gap:5px; margin-left:8px; padding:1px 7px; border:1px solid var(--dsw-alias-separator-regular); border-radius:999px; white-space:nowrap; font-size:11px; line-height:18px; }
.dsh-zcode-tool-badge::before { content:''; width:4px; height:4px; border-radius:50%; background:var(--dsw-alias-state-error-primary); }
.dsh-zcode-tool-diff { flex:none; margin-left:10px; white-space:nowrap; font:calc(var(--dsh-content-font-size-secondary,13px) - 2px)/24px var(--ds-font-family-code); transform:translateY(.5px); }
.dsh-zcode-tool-row[aria-expanded='true'] .dsh-zcode-tool-added { color:var(--dsw-alias-state-success-primary); }
.dsh-zcode-tool-row[aria-expanded='true'] .dsh-zcode-tool-removed { color:var(--dsw-alias-state-error-primary); }
@media (hover:hover) {
  .dsh-zcode-tool-row:hover .dsh-zcode-tool-added { color:var(--dsw-alias-state-success-primary); }
  .dsh-zcode-tool-row:hover .dsh-zcode-tool-removed { color:var(--dsw-alias-state-error-primary); }
}
.dsh-zcode-tool-body { display:flex; flex-direction:column; gap:8px; }
.dsh-zcode-tool-io { margin:4px 0 0 22px; padding:8px 10px; border-radius:6px; background:var(--dsw-alias-background-layer1); color:var(--dsw-alias-label-secondary); white-space:pre-wrap; overflow-wrap:anywhere; font:12px/1.5 var(--ds-font-family-code); }
.dsh-zcode-tool-inspect { align-self:flex-start; margin:2px 0 0 22px; padding:2px 6px; border:0; background:none; color:var(--dsw-alias-label-tertiary); cursor:pointer; display:flex; align-items:center; gap:4px; }
.dsh-zcode-tool-visually-hidden { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
`

function object(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : null
}

function integer(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum
}

function parseArgs(props: ToolviewProps): JsonObject {
  if (props.phase !== 'preparing') {
    const raw = props.phase === 'start' ? props.block.argsRaw : props.block.call?.argsRaw
    if (typeof raw === 'string') {
      try {
        return object(JSON.parse(raw)) ?? {}
      } catch {
        return {}
      }
    }
  }
  const args = props.block.args
  if (args === undefined) return {}
  const out: JsonObject = {}
  for (const key of ['command', 'description', 'file_path', 'content', 'old_string', 'new_string', 'pattern', 'path', 'offset', 'limit']) {
    try {
      if (args.has(key) && args.complete(key)) out[key] = args.text(key)
    } catch {
      return out
    }
  }
  return out
}

function textArg(args: JsonObject, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' ? value : undefined
}

function resultText(block: ResultBlock): string | undefined {
  if (!Array.isArray(block.content)) return undefined
  const parts: string[] = []
  for (const item of block.content) {
    const value = object(item)
    if (value?.type === 'text' && typeof value.text === 'string') {
      parts.push(value.text)
      continue
    }
    try {
      const rendered = JSON.stringify(item, null, 2)
      if (rendered !== undefined) parts.push(rendered)
    } catch {
      parts.push(String(item))
    }
  }
  if (parts.length > 0) return parts.join('\n')
  const { error } = block
  if (error === undefined) return undefined
  const label = [error.name, error.code].filter(value => typeof value === 'string' && value !== '').join(': ')
  return error.reason === undefined ? label || undefined : [label, error.reason].filter(Boolean).join('\n')
}

function readMeta(value: unknown): ReadMeta | undefined {
  const meta = object(value)
  if (meta === null || typeof meta.path !== 'string' || !integer(meta.offset, 1)
    || !integer(meta.totalLines) || !Array.isArray(meta.lines)) return undefined
  if (meta.lang !== undefined && typeof meta.lang !== 'string') return undefined
  const lines: ReadMeta['lines'] = []
  let previous = meta.offset - 1
  for (const value of meta.lines) {
    const line = object(value)
    if (line === null || !integer(line.number, 1) || line.number <= previous
      || line.number > meta.totalLines || typeof line.text !== 'string') return undefined
    lines.push({ number: line.number, text: line.text })
    previous = line.number
  }
  return {
    path: meta.path,
    offset: meta.offset,
    lines,
    totalLines: meta.totalLines,
    ...(typeof meta.lang === 'string' ? { lang: meta.lang } : {}),
  }
}

function mutationMeta(value: unknown): MutationMeta | undefined {
  const meta = object(value)
  if (meta === null || typeof meta.path !== 'string'
    || !Array.isArray(meta.diffs) || meta.diffs.length === 0) return undefined
  const diffs: DiffHunk[] = []
  for (const value of meta.diffs) {
    const diff = object(value)
    if (diff === null || typeof diff.path !== 'string'
      || (diff.oldText !== null && typeof diff.oldText !== 'string')
      || typeof diff.newText !== 'string') return undefined
    diffs.push({ path: diff.path, oldText: diff.oldText, newText: diff.newText })
  }
  return { path: meta.path, diffs }
}

function searchMeta(value: unknown): SearchMeta | undefined {
  const meta = object(value)
  if (meta === null || typeof meta.truncated !== 'boolean' || !integer(meta.total)) return undefined
  if (meta.shape === 'paths') {
    if (!Array.isArray(meta.paths) || !meta.paths.every(path => typeof path === 'string')) return undefined
    return { kind: 'paths', paths: [...meta.paths], truncated: meta.truncated, total: meta.total }
  }
  if (meta.shape !== 'matches' || !Array.isArray(meta.files)) return undefined
  const files: Extract<SearchMeta, { kind: 'matches' }>['files'] = []
  for (const value of meta.files) {
    const file = object(value)
    if (file === null || typeof file.path !== 'string' || !Array.isArray(file.matches)) return undefined
    const matches: Array<{ lineNumber: number; line: string }> = []
    for (const value of file.matches) {
      const match = object(value)
      if (match === null || !integer(match.lineNumber, 1) || typeof match.line !== 'string') return undefined
      matches.push({ lineNumber: match.lineNumber, line: match.line })
    }
    files.push({ path: file.path, matches })
  }
  return { kind: 'matches', files, truncated: meta.truncated, total: meta.total }
}

function bashMeta(value: unknown): BashMeta | undefined {
  const meta = object(value)
  if (meta === null || typeof meta.cwd !== 'string'
    || !['completed', 'failed', 'cancelled', 'spawn_error'].includes(String(meta.status))
    || (meta.exitCode !== null && !integer(meta.exitCode))
    || (meta.signal !== null && typeof meta.signal !== 'string')
    || typeof meta.interrupted !== 'boolean') return undefined
  return {
    cwd: meta.cwd,
    status: meta.status as BashMeta['status'],
    exitCode: meta.exitCode,
    signal: meta.signal,
    interrupted: meta.interrupted,
  }
}

function cleanBashOutput(output: string | undefined): string | undefined {
  if (output === undefined) return undefined
  const cleaned = output
    .replace(/(?:^|\n)__ZCODE_CWD__[^\n]*(?=\n|$)/gu, '')
    .replace(/\n?\[exit code: (?:-?[0-9]+|signal)\]\s*$/u, '')
  return cleaned.trim() === '' ? undefined : cleaned
}

function legacyBashStatus(output: string | undefined): ExitStatus | undefined {
  if (output === undefined) return undefined
  const match = /\n\[exit code: (-?[0-9]+|signal)\]$/u.exec(output)
  if (match?.[1] === undefined) return undefined
  return match[1] === 'signal' ? { exitCode: null } : { exitCode: Number(match[1]) }
}

function settledState(block: ResultBlock, bash?: BashMeta, exit?: ExitStatus): RowState {
  const code = block.error?.code?.toLowerCase() ?? ''
  if (bash?.interrupted === true || bash?.status === 'cancelled'
    || /interrupt|cancel|abort|timeout|timed.?out/u.test(code)) return 'stopped'
  if (block.isError === true || (bash !== undefined
    && (bash.status !== 'completed' || bash.signal !== null || bash.exitCode !== 0))
    || exit?.signal !== undefined || (exit?.exitCode !== undefined && exit.exitCode !== 0)) return 'error'
  return 'ok'
}

function intendedDiff(name: ToolName, args: JsonObject): DiffHunk[] | undefined {
  const path = textArg(args, 'file_path')
  if (path === undefined || path.trim() === '') return undefined
  if (name === 'Write') {
    const content = textArg(args, 'content')
    return content === undefined ? undefined : [{ path, oldText: null, newText: content }]
  }
  if (name !== 'Edit') return undefined
  const oldText = textArg(args, 'old_string')
  const newText = textArg(args, 'new_string')
  return oldText === undefined || newText === undefined
    ? undefined
    : [{ path, oldText: oldText || null, newText }]
}

function model(props: ToolviewProps): ViewModel {
  const name = TOOLS.includes(props.toolName as ToolName) ? props.toolName as ToolName : 'Bash'
  const args = parseArgs(props)
  const rawOutput = props.phase === 'result' ? resultText(props.block) : undefined
  const title = props.t(`tool.title.${name.toLowerCase()}`)
  const filePath = textArg(args, 'file_path')
  const pattern = textArg(args, 'pattern')
  const command = textArg(args, 'command') ?? ''
  const state = props.phase === 'preparing' ? 'preparing' : props.phase === 'start' ? 'running' : settledState(props.block)
  const common = { name, state, title }
  if (name === 'Bash') {
    const meta = props.phase === 'result' ? bashMeta(props.block.meta) : undefined
    const legacy = props.phase === 'result' && meta === undefined ? legacyBashStatus(rawOutput) : undefined
    const exitStatus: ExitStatus | undefined = meta === undefined
      ? legacy
      : {
        exitCode: meta.exitCode,
        ...(meta.signal === null ? {} : { signal: meta.signal }),
      }
    const terminalOutput = props.phase === 'result' ? cleanBashOutput(rawOutput) : undefined
    const nextState = props.phase === 'result' ? settledState(props.block, meta, exitStatus) : state
    return {
      ...common,
      state: nextState,
      summary: textArg(args, 'description') ?? command,
      ...(props.phase === 'result' && (meta === undefined || command === '') && rawOutput !== undefined
        ? { output: rawOutput }
        : {}),
      ...(exitStatus === undefined ? {} : { exitStatus }),
      ...(command === '' || (props.phase === 'result' && meta === undefined) ? {} : {
        terminal: {
          command,
          ...(meta?.cwd === undefined ? {} : { cwd: meta.cwd }),
          ...(terminalOutput === undefined ? {} : { output: terminalOutput }),
          ...(meta === undefined ? {} : {
            exitCode: meta.exitCode,
            ...(meta.signal === null ? {} : { signal: meta.signal }),
          }),
          running: props.phase !== 'result',
        },
      }),
    }
  }
  if (name === 'Read') {
    const read = props.phase === 'result' && props.block.isError !== true ? readMeta(props.block.meta) : undefined
    const offset = args.offset
    const line = read?.offset ?? (integer(offset) ? offset + 1 : undefined)
    const path = read?.path ?? filePath
    return {
      ...common,
      summary: path ?? '',
      ...(path === undefined ? {} : { path }),
      ...(line === undefined ? {} : { line }),
      ...(read === undefined && rawOutput !== undefined ? { output: rawOutput } : {}),
      ...(read === undefined ? {} : { read }),
    }
  }
  if (name === 'Write' || name === 'Edit') {
    const applied = props.phase === 'result' && props.block.isError !== true ? mutationMeta(props.block.meta) : undefined
    const diffs = props.phase === 'result' ? applied?.diffs : intendedDiff(name, args)
    const path = applied?.path ?? filePath
    return {
      ...common,
      summary: path ?? '',
      ...(path === undefined ? {} : { path }),
      ...(diffs === undefined && rawOutput !== undefined ? { output: rawOutput } : {}),
      ...(diffs === undefined ? {} : { diffs }),
    }
  }
  const search = props.phase === 'result' && props.block.isError !== true ? searchMeta(props.block.meta) : undefined
  return {
    ...common,
    summary: pattern ?? '',
    ...(search === undefined && rawOutput !== undefined ? { output: rawOutput } : {}),
    ...(search === undefined ? {} : { search }),
  }
}

function labels(t: Translate) {
  return {
    terminal: {
      commandLine: (line: number) => t('terminal.commandLine', { n: line }),
      signal: (signal: string) => t('terminal.signal', { signal }),
      exitCode: (code: number) => t('terminal.exitCode', { code }),
      noExitCode: t('terminal.noExitCode'),
      running: t('terminal.running'),
      failed: t('terminal.failed'),
      done: t('terminal.done'),
      copy: t('copy'),
      copied: t('copied'),
      noOutput: t('terminal.noOutput'),
      collapseAria: t('terminal.collapseAria'),
      collapse: t('collapse'),
      expandAria: (count: number) => t('terminal.expandAria', { n: count }),
      expand: (count: number) => t('terminal.expandRest', { n: count }),
    },
    diff: {
      codeLabel: t('codeBlock.title'),
      wrapLabel: t('codeBlock.wrap'),
      unwrapLabel: t('codeBlock.unwrap'),
      copy: t('copy'),
      copied: t('copied'),
      collapseAria: t('diff.collapseAria'),
      expandAria: (count: number) => t('diff.expandAria', { count }),
      collapse: t('collapse'),
      expand: (count: number) => t('diff.expandRest', { count }),
    },
    read: {
      codeLabel: t('codeBlock.title'),
      wrapLabel: t('codeBlock.wrap'),
      unwrapLabel: t('codeBlock.unwrap'),
      window: (shown: number, total: number) => t('read.window', { shown, total }),
      copy: t('copy'),
      copied: t('copied'),
      collapseAria: t('read.collapseAria'),
      expandAria: (count: number) => t('read.expandAria', { count }),
      collapse: t('collapse'),
      expand: (count: number) => t('read.expandRest', { count }),
    },
    search: {
      pathsSummary: (shown: number, total: number, truncated: boolean) =>
        t(truncated ? 'search.paths.truncated' : 'search.paths', { shown, total }),
      matchesSummary: (shown: number, total: number, files: number, truncated: boolean) =>
        t(truncated ? 'search.matches.truncated' : 'search.matches', { shown, total, files }),
      copy: t('copy'),
      copied: t('copied'),
      noResults: t('search.noResults'),
      collapseAria: t('search.collapseAria'),
      expandAria: (count: number) => t('search.expandAria', { count }),
      collapse: t('collapse'),
      expand: (count: number) => t('search.expandRest', { count }),
    },
  }
}

function icon(name: ToolName): ReactNode {
  if (name === 'Bash') return h(IconApiOutlineRegular, { size: 14 })
  if (name === 'Read') return h(IconBrowseOutlineRegular, { size: 14 })
  if (name === 'Write' || name === 'Edit') return h(IconEditOutlineRegular, { size: 14 })
  return h(IconSearchOutlineRegular, { size: 14 })
}

function stateStatus(state: RowState, t: Translate): string | undefined {
  if (state === 'preparing') return t('row.preparing')
  if (state === 'running') return t('row.running')
  if (state === 'error') return t('row.failed')
  if (state === 'stopped') return t('row.stopped')
  return undefined
}

function body(view: ViewModel, props: ToolviewProps): ReactNode {
  const copy = labels(props.t)
  let card: ReactNode = null
  if (view.terminal !== undefined) {
    card = h(TerminalBlock, { ...view.terminal, labels: copy.terminal, maxLines: Infinity })
  } else if (view.diffs !== undefined) {
    card = h(DiffBlock, { diffs: view.diffs, labels: copy.diff, maxLines: 9 })
  } else if (view.read !== undefined) {
    card = h(ReadBlock, {
      label: view.read.path,
      lines: view.read.lines,
      totalLines: view.read.totalLines,
      ...(view.read.lang === undefined ? {} : { lang: view.read.lang }),
      labels: copy.read,
      maxLines: 8,
    })
  } else if (view.search !== undefined) {
    card = h(SearchBlock, { ...view.search, labels: copy.search, maxLines: 8 })
  }
  return h('div', { className: 'dsh-zcode-tool-body' }, [
    card,
    view.output === undefined ? null : h('pre', { key: 'output', className: 'dsh-zcode-tool-io' }, view.output),
    props.inspect === undefined ? null : h('button', {
      key: 'inspect',
      type: 'button',
      className: 'dsh-zcode-tool-inspect',
      onClick: props.inspect,
    }, [h(IconInspectOutlineRegular, { key: 'icon', size: 14 }), props.t('row.inspect')]),
  ])
}

function exitLabel(view: ViewModel, t: Translate): string | undefined {
  if (view.exitStatus === undefined || view.state !== 'error') return undefined
  if (view.exitStatus.signal !== undefined) return t('terminal.signal', { signal: view.exitStatus.signal })
  if (view.exitStatus.exitCode == null) return t('terminal.noExitCode')
  return t('terminal.exitCode', { code: view.exitStatus.exitCode })
}

/** Render one uppercase ZCode call without changing its recorded wire name. */
export function ZCodeToolview(props: ToolviewProps): ReactNode {
  const { expanded, toggle } = props.useDisclosure()
  const view = model(props)
  const hasBody = view.terminal !== undefined || view.diffs !== undefined || view.read !== undefined
    || view.search !== undefined || view.output !== undefined || props.inspect !== undefined
  const open = expanded && view.state !== 'preparing' && hasBody
  const status = stateStatus(view.state, props.t)
  const badge = exitLabel(view, props.t)
  const totals = view.diffs === undefined || view.state === 'error' || view.state === 'stopped'
    ? undefined
    : diffTotals(view.diffs)
  const summary: ReactNode[] = []
  if (status !== undefined) {
    summary.push(h('span', { key: 'status', className: 'dsh-zcode-tool-visually-hidden' }, status))
  }
  if (view.summary !== '') {
    summary.push(
      h('span', { key: 'dot', className: 'dsh-zcode-tool-dot', 'aria-hidden': true }),
      view.path !== undefined && view.state !== 'error' && view.state !== 'stopped'
        ? h('button', {
          key: 'summary',
          type: 'button',
          className: 'dsh-zcode-tool-summary dsh-zcode-tool-path',
          onClick: (event: { stopPropagation(): void }) => {
            event.stopPropagation()
            props.openFile(view.path!, view.line === undefined ? undefined : { line: view.line })
          },
        }, view.summary)
        : h('span', { key: 'summary', className: 'dsh-zcode-tool-summary' }, view.summary),
    )
  }
  if (badge !== undefined) {
    summary.push(h('span', { key: 'badge', className: 'dsh-zcode-tool-badge' }, badge))
  }
  if (totals !== undefined) {
    summary.push(h('span', { key: 'diff', className: 'dsh-zcode-tool-diff' }, [
      h('span', { key: 'added', className: 'dsh-zcode-tool-added' }, `+${totals.added}`),
      ' ',
      h('span', { key: 'removed', className: 'dsh-zcode-tool-removed' }, `-${totals.removed}`),
    ]))
  }
  return h('div', {
    className: 'dsh-zcode-tool',
    'data-tool': view.name,
    'data-state': view.state,
  }, [
    h(DisclosureRow, {
      key: 'row',
      rowClassName: 'dsh-zcode-tool-row',
      titleClassName: 'dsh-zcode-tool-title',
      icon: icon(view.name),
      title: view.title,
      running: view.state === 'preparing' || view.state === 'running',
      open,
      expandable: view.state !== 'preparing' && hasBody,
      expandOnRowClick: true,
      keepContentWhenOpen: true,
      onToggle: toggle,
      collapsedContent: summary.length === 0 ? undefined : summary,
    }, open ? body(view, props) : undefined),
  ])
}

function installStyles(): () => void {
  if (typeof document === 'undefined' || document.getElementById('dsh-zcode-toolviews-style') !== null) {
    return () => {}
  }
  const style = document.createElement('style')
  style.id = 'dsh-zcode-toolviews-style'
  style.textContent = STYLE
  document.head.append(style)
  return () => style.remove()
}

/** Register the six exact capitalized ZCode wire names. */
export function mountToolviews(ctx: {
  effect: (setup: () => (() => void) | void, label: string) => unknown
  slots?: ClientSlotsLike
}): void {
  ctx.effect(() => {
    const removeStyles = installStyles()
    const slots = ctx.slots
    if (slots === undefined) return removeStyles
    const removeSlots = slots.inject('tool.call.toolview', function* () {
      for (const key of TOOLS) {
        yield slots.register({
          name: 'tool.call.toolview',
          key,
          locale: 'conversation',
        }, ZCodeToolview)
      }
    })
    return () => {
      removeSlots()
      removeStyles()
    }
  }, '@spectershell/dsh-harness-zcode: tool views')
}
