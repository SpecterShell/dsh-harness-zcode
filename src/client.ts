/**
 * Browser entry for ZCode localization and plugin settings registration.
 * @module
 */
import { mountSettingsCard } from './client-settings.js'
import type { SettingsContext } from './client-settings.js'
import { mountToolviews } from './client-toolviews.js'
import { locales } from './locales.ts'

export { mountSettingsCard }
export { mountToolviews, ZCodeToolview } from './client-toolviews.js'
export { locales }

/** Client context required by the installed ZCode browser entry. */
export interface ClientContext extends SettingsContext {
  locale: {
    register: (namespace: string, dictionaries: Record<string, Record<string, string>>) => () => void
    bind: (namespace: string) => (key: string) => string
  }
}

/**
 * Register dictionaries and mount the settings contribution for this lifetime.
 * @param ctx - Browser plugin context with locale, slot, and config-form services.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(
    () => ctx.locale.register('@spectershell/dsh-harness-zcode', locales),
    '@spectershell/dsh-harness-zcode: locales',
  )
  mountSettingsCard(ctx, ctx.locale.bind('@spectershell/dsh-harness-zcode'))
  mountToolviews(ctx)
}

/** Required client services declared to the Cordis loader. */
export const inject = ['locale', 'slots', 'configForms']
