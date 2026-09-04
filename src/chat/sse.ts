import { EventSourceParserStream } from 'eventsource-parser/stream'
import { LlmError } from '@deepseek-ai/dsh-llm'

export const DONE = '[DONE]'

/** Parse spec-compliant SSE and require the terminal OpenAI-compatible [DONE] marker. */
export async function* parseSse(
  stream: ReadableStream<BufferSource>,
): AsyncGenerator<string> {
  const events = stream
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream())

  for await (const { data } of events) {
    yield data
    if (data === DONE) return
  }
  throw new LlmError('SSE stream ended without [DONE].', 'STREAM_CLOSED')
}
