/**
 * Resolve identity-sensitive peer imports through the installed DSH host during tests.
 *
 * The native integration fixtures create Session instances from the installed host.
 * Redirecting the project import to that same module matches deployed peer resolution
 * and keeps Session private fields and appendPluginRecord in one class identity.
 */
import { realpathSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { installedHostAnchor } from './native-anchor.ts'

const anchor = installedHostAnchor()
const require = createRequire(anchor)
const sessionEntry = pathToFileURL(realpathSync(require.resolve('@deepseek-ai/dsh-session'))).href

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/dsh-session') {
      return { url: sessionEntry, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})
