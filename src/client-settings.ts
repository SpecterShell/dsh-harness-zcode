/**
 * Staged settings form for the ZCode bundle on the Plugins page.
 *
 * The Host owns validation and persistence. This module projects its served
 * config document into localized controls and keeps edits local until save.
 * @module
 */
import { createElement as h, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import {
  SegmentedControl,
  SettingsForm,
  SettingsFormModel,
  SettingsValueField,
  Switch,
  settingsNumberField,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  SettingsFieldSpec,
  SettingsFieldState,
  SettingsFormScope,
  SettingsFormShell,
} from '@deepseek-ai/dsh-client-ui-primitives'

/** Small common surface of the browser Slots service used by this bundle. */
export interface ClientSlotsLike {
  inject(
    key: string,
    callback: () => void | (() => void) | Iterable<() => void>,
  ): () => void
  register(
    options: {
      name: string
      key: string
      locale: string
      label?: () => string
      inject?: (...args: never[]) => unknown
    },
    factory: (...args: never[]) => unknown,
  ): () => void
}

/** Client config-form contract used to observe and mutate one served entry. */
interface ConfigFormsLike {
  get<T>(entryId: string): SettingsFormScope<T>
  whileServed(namespaces: readonly string[], register: (served: ReadonlySet<string>) => () => void): () => void
}

/** Optional client services needed to mount the settings card. */
export interface SettingsContext {
  effect: (setup: () => (() => void) | void, label: string) => unknown
  slots?: ClientSlotsLike
  configForms?: ConfigFormsLike
}

/** Shape of the Host config document exposed to this form. */
interface ZcodeSettings {
  searchMode?: 'bash' | 'tools'
  surfaceAllow?: string
  headless?: boolean
  memoryEnabled?: boolean
  memoryExtractionEnabled?: boolean
  compactionEnabled?: boolean
  microcompactionEnabled?: boolean
  compactionThreshold?: number
  microcompactionThreshold?: number
  memoryMaxBytes?: number
  workspaceMemoryRoot?: string
}

/** Form shell plus the staged state of every ZCode field. */
interface CardState extends SettingsFormShell {
  searchMode: SettingsFieldState
  surfaceAllow: SettingsFieldState
  headless: SettingsFieldState
  memoryEnabled: SettingsFieldState
  memoryExtractionEnabled: SettingsFieldState
  compactionEnabled: SettingsFieldState
  microcompactionEnabled: SettingsFieldState
  compactionThreshold: SettingsFieldState
  microcompactionThreshold: SettingsFieldState
  memoryMaxBytes: SettingsFieldState
  workspaceMemoryRoot: SettingsFieldState
}

/** Runtime props injected into the bundle settings card. */
interface CardProps {
  t: (key: string) => string
  useZcodeSettingsCard: <S>(select: (snapshot: CardState) => S) => S
  edit: (field: string, text: string) => void
  resetField: (field: string) => void
  save: () => void
  discard: () => void
}

/**
 * Define a string field restricted to a fixed set of choices.
 * @param field - Config property written by the field.
 * @param choices - Accepted values in display and fallback order.
 * @returns A staged field specification for `SettingsFormModel`.
 */
function choiceField(field: string, choices: readonly string[]): SettingsFieldSpec {
  return {
    field,
    format: value => typeof value === 'string' ? value : choices[0]!,
    parse: text => choices.includes(text) ? { kind: 'set', value: text } : undefined,
  }
}

/**
 * Define a boolean field represented internally as `true` or `false` text.
 * @param field - Config property written by the field.
 * @returns A staged boolean field specification.
 */
function booleanField(field: string): SettingsFieldSpec {
  return {
    field,
    format: value => value === true ? 'true' : 'false',
    parse: text => text === 'true'
      ? { kind: 'set', value: true }
      : text === 'false'
        ? { kind: 'set', value: false }
        : undefined,
  }
}

/**
 * Define a text field where an empty draft clears the user override.
 * @param field - Config property written by the field.
 * @returns A staged text field specification.
 */
function textField(field: string): SettingsFieldSpec {
  return {
    field,
    format: value => typeof value === 'string' ? value : '',
    parse: text => text.length === 0 ? { kind: 'clear' } : { kind: 'set', value: text },
  }
}

/** Field codecs shared by the rendered controls and save operation. */
const SPECS = [
  choiceField('searchMode', ['bash', 'tools']),
  textField('surfaceAllow'),
  booleanField('headless'),
  booleanField('memoryEnabled'),
  booleanField('memoryExtractionEnabled'),
  booleanField('compactionEnabled'),
  booleanField('microcompactionEnabled'),
  settingsNumberField('compactionThreshold'),
  settingsNumberField('microcompactionThreshold'),
  settingsNumberField('memoryMaxBytes'),
  textField('workspaceMemoryRoot'),
]

/** Entry ids used by direct rows and bundle includes respectively. */
const NAMESPACES = [
  '@spectershell/dsh-harness-zcode',
  'include:@spectershell/dsh-harness-zcode',
]

/** Card-local layout matching the normal DSH settings form rhythm. */
const STYLE = `
.dsh-harness-zcode-settings-field { padding: 12px 0; border-top: 0.5px solid var(--dsw-alias-border-l2); }
.dsh-harness-zcode-settings-head { display: flex; align-items: center; gap: 8px; }
.dsh-harness-zcode-settings-label { flex: 1; min-width: 0; font-size: 13px; font-weight: 500; line-height: 1.5; color: var(--dsw-alias-label-primary); }
.dsh-harness-zcode-settings-hint { margin: 4px 0 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.dsh-harness-zcode-settings-reset { padding: 0; border: 0; background: none; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.dsh-harness-zcode-settings-reset:disabled { cursor: default; opacity: 0.5; }
.dsh-harness-zcode-settings-badge { font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.dsh-harness-zcode-settings-search { max-width: 240px; }
`

/**
 * Render the accessible action that removes one user override.
 * @param props - Localized label, target field label, state, and reset action.
 * @returns A button whose accessible name identifies the affected field.
 */
function ResetButton(props: {
  label: string
  fieldLabel: string
  disabled: boolean
  onReset: () => void
}): ReactNode {
  return h('button', {
    type: 'button',
    className: 'dsh-harness-zcode-settings-reset',
    disabled: props.disabled,
    'aria-label': `${props.label}: ${props.fieldLabel}`,
    onClick: props.onReset,
  }, props.label)
}

/**
 * Render one boolean setting with the platform switch and override metadata.
 * @param props - Staged value, localized copy, and form actions.
 * @returns A compact settings row with a localized description.
 */
function BooleanToggle(props: {
  id: string
  label: string
  hint: string
  text: string
  overridden: boolean
  disabled: boolean
  overriddenLabel: string
  resetLabel: string
  onEdit: (text: string) => void
  onReset: () => void
}): ReactNode {
  const checked = props.text === 'true'
  return h('div', { className: 'dsh-harness-zcode-settings-field' }, [
    h('div', { key: 'head', className: 'dsh-harness-zcode-settings-head' }, [
      h('span', { key: 'label', className: 'dsh-harness-zcode-settings-label' }, props.label),
      props.overridden
        ? h('span', { key: 'badge', className: 'dsh-harness-zcode-settings-badge' }, props.overriddenLabel)
        : null,
      props.overridden
        ? h(ResetButton, {
          key: 'reset',
          label: props.resetLabel,
          fieldLabel: props.label,
          disabled: props.disabled,
          onReset: props.onReset,
        })
        : null,
      h(Switch, {
        key: 'toggle',
        checked,
        disabled: props.disabled,
        label: props.label,
        onChange: next => props.onEdit(next ? 'true' : 'false'),
      }),
    ]),
    h('p', { key: 'hint', className: 'dsh-harness-zcode-settings-hint' }, props.hint),
  ])
}

/**
 * Render the two supported search surfaces as a compact segmented control.
 * @param props - Staged search mode, localized copy, and form actions.
 * @returns The search-mode settings row.
 */
function SearchModeField(props: {
  state: SettingsFieldState
  disabled: boolean
  t: (key: string) => string
  onEdit: (text: string) => void
  onReset: () => void
}): ReactNode {
  const label = props.t('settings.searchMode')
  return h('div', { className: 'dsh-harness-zcode-settings-field' }, [
    h('div', { key: 'head', className: 'dsh-harness-zcode-settings-head' }, [
      h('span', {
        key: 'label',
        className: 'dsh-harness-zcode-settings-label',
      }, label),
      props.state.overridden
        ? h('span', {
          key: 'badge',
          className: 'dsh-harness-zcode-settings-badge',
        }, props.t('settings.overridden'))
        : null,
      props.state.overridden
        ? h(ResetButton, {
          key: 'reset',
          label: props.t('settings.reset'),
          fieldLabel: label,
          disabled: props.disabled,
          onReset: props.onReset,
        })
        : null,
      h('div', { key: 'control', className: 'dsh-harness-zcode-settings-search' },
        h(SegmentedControl, {
          id: 'zcode-settings-searchMode',
          value: props.state.text as 'bash' | 'tools',
          options: [
            { value: 'bash', label: props.t('settings.searchBash') },
            { value: 'tools', label: props.t('settings.searchTools') },
          ],
          onChange: next => props.onEdit(next),
          label,
          disabled: props.disabled,
        })),
    ]),
    h('p', {
      key: 'hint',
      className: 'dsh-harness-zcode-settings-hint',
    }, props.t('settings.searchModeHint')),
  ])
}

/**
 * Render a normal text or number field from a named form snapshot property.
 * @param props - Card translations and form actions.
 * @param state - Current form projection.
 * @param name - Config field to render.
 * @param numeric - Whether the control should use numeric input behavior.
 * @returns A settings value field wired to staged edit and reset actions.
 */
function field(
  props: CardProps,
  state: CardState,
  name: keyof ZcodeSettings & keyof CardState,
  numeric = false,
): ReactNode {
  return h(SettingsValueField, {
    id: `zcode-settings-${name}`,
    label: props.t(`settings.${name}`),
    hint: props.t(`settings.${name}Hint`),
    ...state[name],
    overriddenLabel: props.t('settings.overridden'),
    resetLabel: props.t('settings.reset'),
    invalidLabel: props.t(numeric ? 'settings.invalidNumber' : 'settings.invalidText'),
    disabled: !state.writable || state.saving,
    numeric,
    onEdit: (text: string) => props.edit(name, text),
    onReset: () => props.resetField(name),
  })
}

/**
 * Render the complete ZCode settings form.
 * @param props - Injected translator, snapshot hook, and form actions.
 * @returns The staged form and all eleven config controls.
 */
function Card(props: CardProps): ReactNode {
  const state = props.useZcodeSettingsCard(snapshot => snapshot)
  const disabled = !state.writable || state.saving
  const boolean = (name: 'headless' | 'memoryEnabled' | 'memoryExtractionEnabled' | 'compactionEnabled' | 'microcompactionEnabled') =>
    h(BooleanToggle, {
      key: name,
      id: `zcode-settings-${name}`,
      label: props.t(`settings.${name}`),
      hint: props.t(`settings.${name}Hint`),
      text: state[name].text,
      overridden: state[name].overridden,
      disabled,
      overriddenLabel: props.t('settings.overridden'),
      resetLabel: props.t('settings.reset'),
      onEdit: text => props.edit(name, text),
      onReset: () => props.resetField(name),
    })
  return h(SettingsForm, {
    labels: {
      unavailable: props.t('settings.unavailable'),
      readOnly: props.t('settings.readOnly'),
      saveFailed: props.t('settings.saveFailed'),
      save: props.t('settings.save'),
      saving: props.t('settings.saving'),
    },
    state,
    onSave: props.save,
    onDiscard: props.discard,
  }, [
    h('style', { key: 'style' }, STYLE),
    h(SearchModeField, {
      key: 'searchMode',
      state: state.searchMode,
      disabled,
      t: props.t,
      onEdit: text => props.edit('searchMode', text),
      onReset: () => props.resetField('searchMode'),
    }),
    field(props, state, 'surfaceAllow'),
    boolean('headless'),
    boolean('memoryEnabled'),
    boolean('memoryExtractionEnabled'),
    boolean('compactionEnabled'),
    boolean('microcompactionEnabled'),
    field(props, state, 'compactionThreshold', true),
    field(props, state, 'microcompactionThreshold', true),
    field(props, state, 'memoryMaxBytes', true),
    field(props, state, 'workspaceMemoryRoot'),
  ])
}

/**
 * Register the card while either ZCode config entry id is served.
 *
 * Each served lifetime owns one form model and slot contribution. Disposal
 * removes both, preventing stale controls after the bundle is disabled.
 * @param ctx - Client services that host settings forms and plugin slots.
 * @param translate - Translator bound to the ZCode locale namespace.
 */
export function mountSettingsCard(ctx: SettingsContext, translate: (key: string) => string): void {
  ctx.effect(() => {
    const slots = ctx.slots
    const configForms = ctx.configForms
    if (slots === undefined || configForms === undefined) return
    return configForms.whileServed(NAMESPACES, served => {
      const namespace = NAMESPACES.find(name => served.has(name)) ?? NAMESPACES[0]!
      const model = new SettingsFormModel(configForms.get<ZcodeSettings>(namespace), SPECS)
      const store = model.bind((): CardState => ({
        ...model.shell(),
        searchMode: model.field('searchMode'),
        surfaceAllow: model.field('surfaceAllow'),
        headless: model.field('headless'),
        memoryEnabled: model.field('memoryEnabled'),
        memoryExtractionEnabled: model.field('memoryExtractionEnabled'),
        compactionEnabled: model.field('compactionEnabled'),
        microcompactionEnabled: model.field('microcompactionEnabled'),
        compactionThreshold: model.field('compactionThreshold'),
        microcompactionThreshold: model.field('microcompactionThreshold'),
        memoryMaxBytes: model.field('memoryMaxBytes'),
        workspaceMemoryRoot: model.field('workspaceMemoryRoot'),
      }))
      const actions = model.actions()
      const disposeSlot = slots.inject('plugins.bundle.config', () => slots.register({
        name: 'plugins.bundle.config',
        key: '@spectershell/dsh-harness-zcode',
        label: () => translate('settings.title'),
        locale: '@spectershell/dsh-harness-zcode',
        inject: () => ({}),
      }, () => h(Card, {
        t: translate,
        useZcodeSettingsCard: select => useSyncExternalStore(
          store.subscribe.bind(store),
          () => select(store.getSnapshot()),
          () => select(store.getSnapshot()),
        ),
        ...actions,
      })))
      return () => {
        disposeSlot()
        model.dispose()
      }
    })
  }, '@spectershell/dsh-harness-zcode: settings card')
}
