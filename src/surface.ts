/**
 * Preset-scope tool visibility policy for ZCode compositions.
 * @module
 */
import type { SurfaceContext } from './types.js'

/** Cordis plugin name used in diagnostics and composition rows. */
export const name = 'zcode-surface'

/** Tool registry dependency required before the mask can be installed. */
export const inject = ['tools']

/** Static allow or deny policy supplied by an individual preset row. */
export interface SurfaceConfig {
  allow?: string[]
  deny?: string[]
}

/**
 * Keep the Agent tool surface synchronized with preset and live user policy.
 *
 * In allow mode, every restrictable inherited tool is hidden unless explicitly
 * allowed. In deny mode, only listed names are hidden. `run_code` is always
 * preserved, and the live settings allow list wins over either policy.
 * Reinstalling an identical mask is skipped to avoid recursive tool changes.
 * @param ctx - Preset-scope tool registry, settings service, and event source.
 * @param config - Static allow or deny list from the preset composition.
 */
export function apply(ctx: SurfaceContext, config: SurfaceConfig = {}): void {
  const configured = config.allow ?? []
  if (!Array.isArray(configured) || configured.some(name => typeof name !== 'string')) {
    throw new TypeError('zcode-surface: allow must be an array of tool names')
  }
  const denyOnly = config.deny
  if (denyOnly !== undefined && (!Array.isArray(denyOnly) || denyOnly.some(name => typeof name !== 'string'))) {
    throw new TypeError('zcode-surface: deny must be an array of tool names')
  }

  let masked: string[] = []
  let dispose: (() => void) | undefined
  let syncing = false

  /** Recompute and atomically replace the active restriction when it changes. */
  const sync = (): void => {
    if (syncing) return
    const allowed = new Set([...configured, ...(ctx.get('zcodeSettings')?.surfaceAllow() ?? [])])
    const known = ctx.tools.view().restrictableNames
    const deny = (denyOnly === undefined
      ? [...known].filter(name => name !== 'run_code' && !allowed.has(name))
      : denyOnly.filter(name => known.has(name) && name !== 'run_code' && !allowed.has(name))
    ).sort()
    if (deny.length === masked.length && deny.every((name, index) => name === masked[index])) return
    syncing = true
    try {
      dispose?.()
      dispose = deny.length === 0 ? undefined : ctx.tools.restrict({ deny })
      masked = deny
    } finally {
      syncing = false
    }
  }

  ctx.on('tools/change', sync)
  ctx.on('settings/document-updated', sync)
  sync()
}
