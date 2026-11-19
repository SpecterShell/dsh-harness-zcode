/**
 * A model adapter for plumbing checks.
 *
 * It answers every request with one fixed sentence, so a headless run can be
 * scored on plumbing (profile boots, preset rows mount, session facts readable)
 * without a provider, a key or a network. It is not a benchmark model and its
 * answers say nothing about preset quality.
 */
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

export const name = 'scripted-model'
export const inject = ['llm']

/** Reply text; a fixed sentence keeps the run deterministic. */
const REPLY = 'Scripted model reply: plumbing check only.'

class ScriptedAdapter extends LlmAdapter {
  async resolveModel(provider, model) {
    return { provider, id: model, name: model, context: { contextWindow: 100_000 } }
  }

  async *stream() {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: REPLY }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: REPLY } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 8 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export function apply(ctx) {
  ctx.llm.registerAdapter(['scripted'], new ScriptedAdapter())
}
