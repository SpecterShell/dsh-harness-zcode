/**
 * Narrow Cordis service contracts used by the ZCode surface policy.
 * @module
 */
import type { ZcodeSettingsService } from './config.js'

/** Current set of inherited tool names eligible for restriction. */
export interface ToolsView {
  restrictableNames: ReadonlySet<string>
}

/** Tool registry operations needed to install and dispose a deny mask. */
export interface ToolsServiceLike {
  view(): ToolsView
  restrict(filter: { deny: readonly string[] }): () => void
}

/** Preset-scope context observed by the surface synchronization plugin. */
export interface SurfaceContext {
  tools: ToolsServiceLike
  get(name: 'zcodeSettings'): ZcodeSettingsService | undefined
  on(event: 'tools/change', listener: () => void): void
  on(event: 'settings/document-updated', listener: () => void): void
}
