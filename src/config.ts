/**
 * Live ZCode settings contracts and projections shared by Host and preset rows.
 * @module
 */

/** A config value whose latest resolved value can be read without remounting. */
export interface Volatile<T> {
  get(): T
}

/** Selects shell-embedded search or dedicated Glob and Grep tools. */
export type SearchMode = 'bash' | 'tools'

/** Volatile Host config fields that back the live settings service. */
export interface ZcodeSettingsSource {
  searchMode: Volatile<SearchMode>
  surfaceAllow: Volatile<string>
  headless: Volatile<boolean>
  memoryEnabled: Volatile<boolean>
  memoryExtractionEnabled: Volatile<boolean>
  compactionEnabled: Volatile<boolean>
  microcompactionEnabled: Volatile<boolean>
  compactionThreshold: Volatile<number>
  microcompactionThreshold: Volatile<number>
  memoryMaxBytes: Volatile<number>
  workspaceMemoryRoot: Volatile<string>
}

/** Tool-facing settings read when the tool surface resolves. */
export interface ZcodeToolSettings {
  searchMode: SearchMode
  preserveRunCode: true
}

/** Context-facing settings read for each request and compaction decision. */
export interface ZcodeContextSettings {
  headless: boolean
  memoryEnabled: boolean
  memoryExtractionEnabled: boolean
  compactionEnabled: boolean
  microcompactionEnabled: boolean
  compactionThreshold: number
  microcompactionThreshold: number
  memoryMaxBytes: number
  workspaceMemoryRoot: string
}

/** Stable service face that returns fresh projections of volatile config. */
export interface ZcodeSettingsService {
  tools(): ZcodeToolSettings
  context(): ZcodeContextSettings
  surfaceAllow(): string[]
}

/** Defaults materialized by the Host schema when no user override exists. */
export const defaults = Object.freeze({
  searchMode: 'bash' as const,
  surfaceAllow: '',
  headless: false,
  memoryEnabled: true,
  memoryExtractionEnabled: true,
  compactionEnabled: true,
  microcompactionEnabled: false,
  compactionThreshold: 0.9,
  microcompactionThreshold: 0.7,
  memoryMaxBytes: 32 * 1024,
  workspaceMemoryRoot: '.zcode/memory',
})

/**
 * Parse a comma or whitespace separated tool allow list.
 * @param text - Operator-provided tool names.
 * @returns Deduplicated non-empty names in first-seen order.
 */
export function parseToolNames(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).filter(Boolean))]
}

/**
 * Project volatile Host config into the service consumed by preset plugins.
 *
 * Every method reads its source on demand so saved settings take effect
 * without rebuilding preset scopes. Headless mode suppresses extraction in
 * the returned view while preserving the stored extraction preference.
 * @param config - Volatile fields resolved by the Host schema.
 * @returns A live settings service over those fields.
 */
export function createZcodeSettings(config: ZcodeSettingsSource): ZcodeSettingsService {
  return {
    tools: () => ({
      searchMode: config.searchMode.get(),
      preserveRunCode: true,
    }),
    context: () => {
      const headless = config.headless.get()
      return {
      headless,
      memoryEnabled: config.memoryEnabled.get(),
      memoryExtractionEnabled: headless ? false : config.memoryExtractionEnabled.get(),
      compactionEnabled: config.compactionEnabled.get(),
      microcompactionEnabled: config.microcompactionEnabled.get(),
      compactionThreshold: config.compactionThreshold.get(),
      microcompactionThreshold: config.microcompactionThreshold.get(),
      memoryMaxBytes: config.memoryMaxBytes.get(),
      workspaceMemoryRoot: config.workspaceMemoryRoot.get(),
    }},
    surfaceAllow: () => parseToolNames(config.surfaceAllow.get()),
  }
}
