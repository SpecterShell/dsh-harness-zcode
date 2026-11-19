/**
 * Host entry that validates ZCode settings and provides their live service.
 * @module
 */
import z from '@deepseek-ai/schemastery'
import { createZcodeSettings, defaults } from './config.ts'
import type { ZcodeSettingsService, ZcodeSettingsSource } from './config.js'

/** Resolved schema type whose fields remain volatile after mount. */
export type ZcodeVolatileConfig = ZcodeSettingsSource

/** Host service registry capability used by this entry. */
export interface HostContext {
  provide(name: 'zcodeSettings', value: ZcodeSettingsService): void
}

/**
 * Public configuration schema for all ZCode presets.
 *
 * Every field is volatile so the client settings form can update behavior
 * without remounting the Host entry or active preset scopes.
 */
export const Config = z.object({
  searchMode: z.union([z.const('bash'), z.const('tools')]).default(defaults.searchMode)
    .description('Use embedded Bash search or expose Glob and Grep fallback tools.')
    .volatile(),
  surfaceAllow: z.string().default(defaults.surfaceAllow)
    .description('Comma or space separated inherited tool names to keep visible.')
    .volatile(),
  headless: z.boolean().default(defaults.headless)
    .description('Run without interactive presentation context.')
    .volatile(),
  memoryEnabled: z.boolean().default(defaults.memoryEnabled)
    .description('Enable ZCode memory context.')
    .volatile(),
  memoryExtractionEnabled: z.boolean().default(defaults.memoryExtractionEnabled)
    .description('Extract durable memory from interactive sessions.')
    .volatile(),
  compactionEnabled: z.boolean().default(defaults.compactionEnabled)
    .description('Enable ZCode compaction context.')
    .volatile(),
  microcompactionEnabled: z.boolean().default(defaults.microcompactionEnabled)
    .description('Enable focused compaction below the full compaction threshold.')
    .volatile(),
  compactionThreshold: z.number().min(0.5).max(1).default(defaults.compactionThreshold)
    .description('Context pressure ratio that triggers full compaction.')
    .volatile(),
  microcompactionThreshold: z.number().min(0.25).max(1).default(defaults.microcompactionThreshold)
    .description('Context pressure ratio that triggers microcompaction.')
    .volatile(),
  memoryMaxBytes: z.number().min(1024).max(1048576).default(defaults.memoryMaxBytes)
    .description('Maximum UTF-8 byte budget for injected workspace memory.')
    .volatile(),
  workspaceMemoryRoot: z.string().default(defaults.workspaceMemoryRoot)
    .description('Workspace-relative root for ZCode memory files.')
    .volatile(),
})

/**
 * Provide the live settings service backed by the resolved volatile config.
 * @param ctx - Host plugin context that owns service registration.
 * @param config - Validated volatile settings wrappers.
 */
export function apply(ctx: HostContext, config: ZcodeVolatileConfig): void {
  ctx.provide('zcodeSettings', createZcodeSettings(config))
}
