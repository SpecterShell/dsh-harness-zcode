/**
 * Client UI primitive declarations used to type-check the dynamically loaded
 * browser bundle without adding the Host-provided UI package as a dependency.
 */
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ReactNode } from 'react'

  export interface TerminalBlockLabels {
    commandLine: (line: number) => string
    signal: (signal: string) => string
    exitCode: (code: number) => string
    noExitCode: string
    running: string
    failed: string
    done: string
    copy: string
    copied: string
    noOutput: string
    collapseAria: string
    collapse: string
    expandAria: (count: number) => string
    expand: (count: number) => string
  }
  export interface CodeToolbarLabels {
    codeLabel: string
    wrapLabel: string
    unwrapLabel: string
  }
  export interface DiffBlockLabels extends CodeToolbarLabels {
    copy: string
    copied: string
    collapseAria: string
    expandAria: (count: number) => string
    collapse: string
    expand: (count: number) => string
  }
  export interface ReadBlockLabels extends CodeToolbarLabels {
    window: (shown: number, total: number) => string
    copy: string
    copied: string
    collapseAria: string
    expandAria: (count: number) => string
    collapse: string
    expand: (count: number) => string
  }
  export interface SearchBlockLabels {
    pathsSummary: (shown: number, total: number, truncated: boolean) => string
    matchesSummary: (shown: number, total: number, files: number, truncated: boolean) => string
    copy: string
    copied: string
    noResults: string
    collapseAria: string
    expandAria: (count: number) => string
    collapse: string
    expand: (count: number) => string
  }
  export function DisclosureRow(props: {
    rowClassName?: string
    leadingClassName?: string
    titleClassName?: string
    icon: ReactNode
    title: string
    running: boolean
    open: boolean
    expandable: boolean
    expandOnRowClick?: boolean
    keepContentWhenOpen?: boolean
    onToggle: () => void
    collapsedContent?: ReactNode
    children?: ReactNode
  }): ReactNode
  export function TerminalBlock(props: {
    command: string
    cwd?: string
    output?: string
    exitCode?: number | null
    signal?: string
    running: boolean
    background?: boolean
    labels: TerminalBlockLabels
    maxLines?: number
    className?: string
  }): ReactNode
  export function DiffBlock(props: {
    diffs: readonly { path: string; oldText: string | null; newText: string }[]
    labels: DiffBlockLabels
    maxLines?: number
    className?: string
  }): ReactNode
  export function ReadBlock(props: {
    label: string
    lines: readonly { number: number; text: string }[]
    totalLines: number
    lang?: string
    labels: ReadBlockLabels
    maxLines?: number
    className?: string
  }): ReactNode
  export type SearchBlockProps = {
    kind: 'paths'
    paths: readonly string[]
    truncated: boolean
    total: number
  } | {
    kind: 'matches'
    files: readonly {
      path: string
      matches: readonly { lineNumber: number; line: string }[]
    }[]
    truncated: boolean
    total: number
  }
  export function SearchBlock(props: SearchBlockProps & {
    labels: SearchBlockLabels
    maxLines?: number
    className?: string
  }): ReactNode
  export function diffTotals(
    diffs: readonly { path: string; oldText: string | null; newText: string }[],
  ): { added: number; removed: number }
  export function IconApiOutlineRegular(props: { size?: number }): ReactNode
  export function IconBrowseOutlineRegular(props: { size?: number }): ReactNode
  export function IconEditOutlineRegular(props: { size?: number }): ReactNode
  export function IconInspectOutlineRegular(props: { size?: number }): ReactNode
  export function IconSearchOutlineRegular(props: { size?: number }): ReactNode

  /** Parsed field mutation staged for the next form save. */
  export type SettingsFieldWrite = { kind: 'set'; value: unknown } | { kind: 'clear' }

  /** Codec connecting one config property to its editable text draft. */
  export interface SettingsFieldSpec {
    field: string
    format: (value: unknown) => string
    parse: (text: string) => SettingsFieldWrite | undefined
  }
  /** Render-facing state for one staged settings field. */
  export interface SettingsFieldState {
    text: string
    overridden: boolean
    invalid: boolean
  }
  /** Availability, writability, and save state shared by the whole form. */
  export interface SettingsFormShell {
    available: boolean
    writable: boolean
    dirty: boolean
    invalid: boolean
    saving: boolean
    failed: boolean
  }
  /** Observable Host config document and optimistic mutation endpoint. */
  export interface SettingsFormScope<T> {
    getSnapshot(): {
      status: 'loading' | 'ready' | 'unavailable'
      value: T | undefined
      base: unknown
      user: unknown
      writable: boolean
      revision: number | undefined
    }
    subscribe(listener: () => void): () => void
    /**
     * Apply config path operations against an optional expected revision.
     * @param ops - Ordered set and unset operations.
     * @param expectedRevision - Revision used to reject a stale save.
     */
    mutate(
      ops: readonly ({ op: 'set'; path: readonly string[]; value: unknown } | { op: 'unset'; path: readonly string[] })[],
      expectedRevision?: number,
    ): Promise<boolean>
  }
  /** Controller that stages field edits and coordinates save or discard. */
  export class SettingsFormModel<T> {
    /**
     * @param scope - Served config document to observe and mutate.
     * @param specs - Codecs for the editable fields.
     */
    constructor(scope: SettingsFormScope<T>, specs: SettingsFieldSpec[])
    bind<S>(project: () => S): { getSnapshot(): S; subscribe(listener: () => void): () => void }
    shell(): SettingsFormShell
    field(field: string): SettingsFieldState
    actions(): {
      edit: (field: string, text: string) => void
      resetField: (field: string) => void
      save: () => void
      discard: () => void
    }
    dispose(): void
  }
  /**
   * Create the standard numeric field codec.
   * @param field - Config property written by the field.
   */
  export function settingsNumberField(field: string): SettingsFieldSpec

  /** Render the common settings shell, status messages, and save actions. */
  export function SettingsForm(props: {
    labels: { unavailable: string; readOnly: string; saveFailed: string; save: string; saving: string }
    state: SettingsFormShell
    onSave: () => void
    onDiscard: () => void
    children?: ReactNode
  }): ReactNode
  /** Render a standard text or number field with override reset support. */
  export function SettingsValueField(props: {
    id: string
    label: string
    hint?: string
    text: string
    overridden: boolean
    invalid: boolean
    overriddenLabel: string
    resetLabel: string
    invalidLabel: string
    disabled: boolean
    numeric?: boolean
    onEdit: (text: string) => void
    onReset: () => void
  }): ReactNode
  /** Render the platform two-state switch with a required accessible label. */
  export function Switch(props: {
    checked: boolean
    onChange: (next: boolean) => void
    label: string
    disabled?: boolean
    title?: string
    className?: string
  }): ReactNode
  /** Render a compact single-choice segmented control. */
  export function SegmentedControl<Value extends string>(props: {
    id: string
    value: Value
    options: readonly { value: Value; label: string }[]
    onChange: (next: Value) => void
    label: string
    disabled?: boolean
  }): ReactNode
}
