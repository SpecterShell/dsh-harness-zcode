/**
 * A registered model adapter that records every request and returns fixed text.
 *
 * Compaction proofs need a model that answers deterministically and leaves a
 * record of what it was asked. Everything else in those proofs is the real
 * host: sessions, token meter, prompt registry, filesystem and the preset row.
 */
import { native } from './native-host.ts'
import type { HostValue } from './native-host.ts'

const { LlmAdapter } = await native('dsh-llm')

/** Request-shaped options the host passes to the adapter. */
export interface FakeModelOptions {
  /** Prompt window the host should assume for this model. */
  readonly contextWindow?: number
  /** Fixed reply text. Defaults to one summary sentence. */
  readonly reply?: string
  /**
   * Replies served in order, one per adapter call. Once the script runs out the
   * adapter falls back to `reply`, so a trailing maintenance request still
   * answers instead of throwing.
   */
  readonly script?: ReadonlyArray<{
    readonly text?: string
    /** Terminal reason for a text reply. Defaults to a normal stop. */
    readonly finish?: 'stop' | 'max-tokens'
    readonly toolCall?: { readonly id?: string; readonly name: string; readonly input: unknown }
  }>
}

/** One recorded adapter request. */
export type FakeModelRequest = HostValue

/**
 * Build a fake model adapter.
 * @param options - window size and initial behavior.
 * @returns the adapter plus the requests it has served.
 */
export function createFakeModel(options: FakeModelOptions = {}) {
  const requests: FakeModelRequest[] = []

  class FakeModel extends (LlmAdapter as new () => HostValue) {
    summary = options.reply ?? 'The prior work is summarized here.'
    fail = false
    contextWindow = options.contextWindow ?? 100_000
    /** Replies still to serve. Tests may push a step for one specific call. */
    readonly queue: Array<NonNullable<FakeModelOptions['script']>[number]> = [
      ...(options.script ?? []),
    ]

    async resolveModel(provider: string, model: string) {
      return {
        provider,
        id: model,
        name: model,
        context: { contextWindow: this.contextWindow },
      }
    }

    async *stream(request: HostValue) {
      // Snapshot the request as the adapter sees it. A listener may restore the
      // caller's message array after iteration, so keep our own copy.
      const messages = JSON.parse(JSON.stringify(request.messages ?? [])) as unknown[]
      requests.push({ ...request, messages })
      if (this.fail) throw new Error('fake model failure')
      const step = this.queue.shift()
      if (step?.toolCall) {
        const id = step.toolCall.id ?? `call-${String(requests.length)}`
        const args = JSON.stringify(step.toolCall.input)
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield {
          type: 'tool-call-delta',
          index: 0,
          id,
          name: step.toolCall.name,
          argumentsDelta: args,
        }
        yield {
          type: 'block-end',
          index: 0,
          block: { type: 'tool-call', id, name: step.toolCall.name, arguments: args },
        }
        yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 4 } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      const text = step?.text ?? this.summary
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 4 } }
      yield { type: 'finish', reason: { kind: step?.finish ?? 'stop' } }
    }
  }

  const model = new FakeModel() as HostValue & { summary: string; fail: boolean }
  return { model, requests }
}
