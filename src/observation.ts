/**
 * Private native filesystem observation policy for one ZCode composition.
 * @module
 */
import { Context } from '@deepseek-ai/cordis'
import { apply as applyNativePolicy } from '@deepseek-ai/dsh-fs-observation-policy'
import type { FsObservation, FsTarget, FsVersion, FsWriteIntent } from '@deepseek-ai/dsh-fs'

/** Cordis plugin name used in diagnostics and composition rows. */
export const name = 'zcode-observation-policy'

/** Private native policy operations consumed only by the ZCode tools row. */
export interface ZCodeObservationPolicy {
  observe(target: FsTarget, observation: FsObservation, actor: object): void
  writeIntent(target: FsTarget, actor: object, fallback: () => FsWriteIntent | Promise<FsWriteIntent>): Promise<FsWriteIntent>
  editIntent(
    target: FsTarget,
    actor: object,
    fallback: () => { version: FsVersion } | Promise<{ version: FsVersion }>,
  ): Promise<{ version: FsVersion }>
}

/**
 * Provide one private native policy gate to the sibling ZCode tools row.
 *
 * The native policy is event-only and its intent waterfalls are unbound.
 * Mounting it on the host event bus from a retained preset would affect sibling
 * presets. This private Cordis root preserves the native state machine without
 * registering any host listeners. ZCode tools consult it only from their
 * existing waterfall fallback, so a deployment-wide policy still wins first.
 */
export function apply(ctx: Context): void {
  const policy = new Context()
  applyNativePolicy(policy)
  ctx.effect(() => () => policy.fiber.dispose(), 'dispose private ZCode observation policy')

  const service: ZCodeObservationPolicy = {
    observe(target, observation, actor) {
      ;(policy as any).emit('fs/observed', target, observation, actor)
    },
    async writeIntent(target, actor, fallback) {
      return await (policy as any).waterfall('fs/write-intent', target, actor, fallback) as FsWriteIntent
    },
    async editIntent(target, actor, fallback) {
      return await (policy as any).waterfall('fs/edit-intent', target, actor, fallback) as { version: FsVersion }
    },
  }
  ctx.provide('zcodeObservationPolicy' as never, service as never)
}
