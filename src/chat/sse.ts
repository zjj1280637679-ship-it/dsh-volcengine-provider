import { EventSourceParserStream } from 'eventsource-parser/stream'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { normalizeTransportError } from './errors.js'

export const DONE = '[DONE]'

/** Parse spec-compliant SSE and require the terminal OpenAI-compatible [DONE] marker. */
export async function* parseSse(
  stream: ReadableStream<BufferSource>,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const events = stream
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream())

  try {
    for await (const { data } of events) {
      yield data
      if (data === DONE) return
    }
  } catch (cause) {
    throw normalizeTransportError(cause, signal)
  }
  throw new LlmError('SSE stream ended without [DONE].', 'TRANSPORT')
}
