/**
 * Evaluate the built browser bundle exactly as the Web Client module loader
 * does: the bundle calls `window.__ModuleLoader__.load` with one registration,
 * and the test supplies the two external modules it may require.
 */
import { readFile } from 'node:fs/promises'

/** The exports one built client bundle makes available. */
export interface ClientModule {
  apply: (ctx: unknown) => void
  mountSettingsCard: (...args: unknown[]) => unknown
  mountToolviews: (...args: unknown[]) => unknown
  ZCodeToolview: (props: unknown) => unknown
  [name: string]: unknown
}

interface Registration {
  factory: (requireModule: (name: string) => unknown) => ClientModule
}

/**
 * Load `lib/client.js` behind the production loader banner.
 * @param requireModule - external-module lookup (`react`, primitives).
 * @returns the bundle exports.
 */
export async function loadClientModule(
  requireModule: (name: string) => unknown,
): Promise<ClientModule> {
  const code = await readFile(new URL('../../lib/client.js', import.meta.url), 'utf8')
  let registration: Registration | undefined
  Function('window', code)({
    __ModuleLoader__: {
      load: (next: Registration) => { registration = next },
    },
  })
  if (registration === undefined) throw new Error('the client bundle did not call __ModuleLoader__.load')
  return registration.factory(requireModule)
}
