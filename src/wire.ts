import {
  composeRequestBody,
  type RequestBody,
  type RequestBodyMode,
} from './request-body.js'

export interface ChatCompletionsBodyOptions {
  model: string
  messages: readonly unknown[]
  stream?: boolean
  customBody?: RequestBody
  customBodyMode?: RequestBodyMode
}

/**
 * Build the final OpenAI-compatible body without validating model ids or
 * filtering unknown vendor fields. `raw` mode intentionally allows the caller
 * to replace the entire generated body.
 */
export function buildChatCompletionsBody(
  options: ChatCompletionsBodyOptions,
): RequestBody {
  const base: RequestBody = {
    model: options.model,
    // composeRequestBody owns the JSON-container copy. Avoid serializing the
    // same potentially large data-URL graph once here and again during merge.
    messages: options.messages,
    stream: options.stream ?? true,
  }

  return composeRequestBody(
    base,
    options.customBody ?? {},
    options.customBodyMode ?? 'merge',
  )
}
