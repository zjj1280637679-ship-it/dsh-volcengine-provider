import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'

import type { VerbatimAttachmentRefLike } from './media.js'
import type { OriginalVideoStaging } from './media-fallback-rpc.js'
import { MediaFallbackSelectionError, supportsMediaFallbackRpc } from './media-fallback-rpc.js'

/** Attachments already admitted by the official Commands service, in input order. */
export type AdmittedMediaAttachment =
  | Extract<ContentBlock, { type: 'image' }>
  | { readonly type: 'file'; readonly attachment: VerbatimAttachmentRefLike }

import { MediaCommandInputError, resolveMediaDeclaration } from './media-declaration.js'
import type { MediaDeclaration } from './media-declaration.js'
export { MediaCommandInputError } from './media-declaration.js'
export type { MediaDeclaration } from './media-declaration.js'

/**
 * Construct native media content from explicit declarations and admitted attachments.
 * Standard image references remain normalized images; file references remain verbatim.
 * @param attachments - official host-admitted durable references in input order.
 * @param declarations - one explicit MIME type and optional audio format per attachment.
 * @param prompt - optional model-facing question.
 * @returns media blocks followed by the prompt text, without reading or transforming bytes.
 * @throws MediaCommandInputError for invalid MIME types, counts, or normalized-image declarations.
 */
export function buildMediaContent(
  attachments: readonly AdmittedMediaAttachment[],
  declarations: readonly MediaDeclaration[],
  prompt?: string,
): ContentBlock[] {
  if (attachments.length === 0) throw new MediaCommandInputError('Attach at least one image, video, or audio file before submitting media.')
  if (declarations.length !== attachments.length) {
    throw new MediaCommandInputError(`Declare one MIME type per attachment: received ${declarations.length} declarations for ${attachments.length} attachments.`)
  }
  const resolved = declarations.map(resolveMediaDeclaration)
  const content = attachments.map((block, index): ContentBlock => {
    const declared = resolved[index]!
    if (block.type === 'image') {
      if (declared.mediaType !== block.attachment.mediaType) {
        throw new MediaCommandInputError(`Image ${index + 1} was admitted as ${block.attachment.mediaType}; declare that MIME type. This reference is the host-normalized image, not an original file.`)
      }
      return block
    }
    if (declared.modality === 'image') {
      return { type: 'volcengine-image', attachment: block.attachment, mediaType: declared.mediaType }
    }
    if (declared.modality === 'video') {
      return { type: 'volcengine-video', attachment: block.attachment, mediaType: declared.mediaType }
    }
    return {
      type: 'volcengine-audio', attachment: block.attachment, mediaType: declared.mediaType,
      ...(declared.format === undefined ? {} : { format: declared.format }),
    }
  })
  const text = prompt?.trim() ?? ''
  if (text !== '') content.push({ type: 'text', text })
  return content
}

/**
 * Parse /ark-media arguments and reuse the structured media builder.
 * @param rawInput - comma-separated MIME declarations, followed by ` -- ` and optional prompt text.
 * @param attachments - official command-admitted durable references in input order.
 * @returns the ordered native media content and optional text question.
 * @throws MediaCommandInputError for invalid grammar or declarations.
 */
export function buildMediaCommandContent(
  rawInput: string,
  attachments: readonly AdmittedMediaAttachment[],
): ContentBlock[] {
  const match = /^\s*(.*?)\s+--(?:\s([\s\S]*))?$/u.exec(rawInput)
  if (match === null) {
    throw new MediaCommandInputError('Use /ark-media video/mp4,audio/mpeg -- your question, with one MIME type per attachment.')
  }
  const declarations = match[1]!.split(',').map((part): MediaDeclaration => {
    const value = part.trim()
    const separator = value.indexOf('=')
    return separator === -1
      ? { mediaType: value }
      : { mediaType: value.slice(0, separator), format: value.slice(separator + 1) }
  })
  return buildMediaContent(attachments, declarations, match[2])
}

/** Structural public Agent face avoids requiring new Harness packages on the image-only baseline. */
interface CommandAgent {
  readonly id: string
  readonly session: {
    readonly id: string
    requestHeader(): { readonly config: { readonly provider: string; readonly model?: string } } | undefined
  }
  steer(message: ReturnType<typeof createUserMessage>): void
}

interface MediaCommandInvocation {
  readonly agent: CommandAgent
  readonly rawInput: string
  readonly attachments: readonly AdmittedMediaAttachment[]
  readonly signal: AbortSignal
}

type MediaCommandResult = { readonly kind: 'success' } | { readonly kind: 'error'; readonly text: string }

interface MediaCommandDefinition {
  readonly name: string
  readonly description: string
  readonly input?: { readonly hint: string; readonly attachments?: true; readonly images?: boolean }
  readonly recordInput?: boolean
  readonly handler: (invocation: MediaCommandInvocation) => MediaCommandResult | Promise<MediaCommandResult>
}

interface CommandsService {
  register(definition: MediaCommandDefinition): () => void
}

interface ModelSelectionProjections {
  stateOf(session: CommandAgent['session'], key: 'modelSelection'):
    | { readonly pending: { readonly provider: string; readonly model?: string } | null }
    | undefined
}

interface DefaultModelService {
  currentSelection(): { readonly provider: string; readonly model?: string }
}

/**
 * Read the public sources used by Session Controller's selectionFor() at d347e703,
 * packages/api/session-controller/src/agent.ts: pending selection, request header,
 * then the default model. Agent.options can predate a UI model switch.
 */
export function selectedModel(ctx: Context, agent: CommandAgent): { readonly provider: string; readonly model?: string } | undefined {
  const projections = ctx.get('sessionProjections') as ModelSelectionProjections | undefined
  const pending = projections?.stateOf(agent.session, 'modelSelection')?.pending
  if (pending !== undefined && pending !== null) return pending
  const header = agent.session.requestHeader()
  if (header !== undefined) return header.config
  const defaults = ctx.get('agentDefaultModel') as DefaultModelService | undefined
  return defaults?.currentSelection()
}

function selectedProvider(ctx: Context, agent: CommandAgent): string | undefined {
  return selectedModel(ctx, agent)?.provider
}

/**
 * Register /ark-media only while official Commands and verbatim file-read services exist.
 * Cordis injection and effects own registration, replacement, and plugin disposal.
 * @param ctx - owning provider-plugin context.
 * @param isOwnedProvider - whether a selected route belongs to this plugin and is currently enabled.
 */
export function registerMediaCommand(ctx: Context, isOwnedProvider: (provider: string) => boolean): void {
  ctx.inject(['commands', 'attachments'], (commandCtx) => {
    const attachments = commandCtx.get('attachments') as { readonly readFileStream?: unknown } | undefined
    if (typeof attachments?.readFileStream !== 'function') return
    const commands = commandCtx.get('commands') as CommandsService
    commandCtx.effect(() => commands.register({
      name: 'ark-media',
      description: 'Send attached media to the selected Volcengine model using explicit MIME types.',
      input: { hint: 'video/mp4,audio/mpeg -- question', attachments: true },
      handler: ({ agent, rawInput, attachments: admitted, signal }) => {
        if (signal.aborted) return { kind: 'error', text: 'Media submission was cancelled before delivery.' }
        const provider = selectedProvider(commandCtx, agent)
        if (provider === undefined) return { kind: 'error', text: 'The current model selection is unavailable. Select a Volcengine model before using /ark-media.' }
        if (!isOwnedProvider(provider)) return { kind: 'error', text: 'Select an enabled Volcengine provider before using /ark-media. This command does not change the selected model.' }
        let content: ContentBlock[]
        try {
          content = buildMediaCommandContent(rawInput, admitted)
        } catch (error) {
          if (error instanceof MediaCommandInputError) return { kind: 'error', text: error.message }
          throw error
        }
        // No await separates the last cancellation check from the durable Agent submission.
        if (signal.aborted) return { kind: 'error', text: 'Media submission was cancelled before delivery.' }
        agent.steer(createUserMessage({ content, source: { kind: 'user' } }))
        return { kind: 'success' }
      },
    }))
  })
}

const LOCAL_TOKEN_PATTERN = /^[a-f0-9]{64}$/u

function exactAgentSession(agent: CommandAgent): string | undefined {
  if (typeof agent.id !== 'string' || agent.id === ''
    || typeof agent.session.id !== 'string' || agent.session.id !== agent.id) return undefined
  return agent.id
}

/**
 * Register the token-only rc.2 fallback command. The original bytes and prompt
 * never appear in command input or attachment admission; both are recovered
 * from a short-lived, same-session staging token.
 */
export function registerLocalMediaCommand(
  ctx: Context,
  isOwnedProvider: (provider: string) => boolean,
  staging: OriginalVideoStaging,
): void {
  ctx.inject(['commands', 'connection'], commandCtx => {
    if (!supportsMediaFallbackRpc(commandCtx)) return
    const commands = commandCtx.get('commands') as CommandsService
    commandCtx.effect(() => commands.register({
      name: 'ark-media-local',
      description: 'Send one staged original MP4 to the selected Volcengine model.',
      input: { hint: '<staging-token>' },
      recordInput: false,
      handler: async ({ agent, rawInput, attachments, signal }) => {
        if (signal.aborted) return { kind: 'error', text: 'Original MP4 submission was cancelled before delivery.' }
        if (attachments.length !== 0) {
          return { kind: 'error', text: 'The original MP4 command does not accept composer attachments.' }
        }
        const sessionId = exactAgentSession(agent)
        if (sessionId === undefined) {
          return { kind: 'error', text: 'The receiving Agent and Session identity could not be verified.' }
        }
        const token = rawInput.trim()
        if (!LOCAL_TOKEN_PATTERN.test(token)) {
          return { kind: 'error', text: 'The staged original MP4 token is invalid or no longer available.' }
        }
        const selection = selectedModel(commandCtx, agent)
        if (selection === undefined || typeof selection.model !== 'string' || selection.model === '') {
          return { kind: 'error', text: 'The current model selection is unavailable. Select a Volcengine model before submitting the MP4.' }
        }
        if (!isOwnedProvider(selection.provider)) {
          return { kind: 'error', text: 'Select an enabled Volcengine provider before submitting the MP4. This command does not change the selected model.' }
        }
        // take() removes the entry before awaiting filesystem publication, so
        // parallel execution and replay cannot submit the staged payload twice.
        let staged
        try {
          staged = await staging.take(sessionId, token, selection.provider, selection.model, signal)
        } catch (error) {
          if (error instanceof MediaFallbackSelectionError) {
            return { kind: 'error', text: 'The selected provider or model changed after upload; the original MP4 was not delivered.' }
          }
          return signal.aborted
            ? { kind: 'error', text: 'Original MP4 submission was cancelled before delivery.' }
            : { kind: 'error', text: 'The original MP4 submission could not be completed.' }
        }
        if (staged === undefined) {
          return { kind: 'error', text: 'The staged original MP4 token is invalid or no longer available.' }
        }
        try {
          signal.throwIfAborted()
          const latest = selectedModel(commandCtx, agent)
          if (latest?.provider !== staged.expectedProvider || latest.model !== staged.expectedModel
            || !isOwnedProvider(latest.provider)) {
            return { kind: 'error', text: 'The selected provider or model changed before delivery; the original MP4 was not delivered.' }
          }
          const content: ContentBlock[] = [{
            type: 'volcengine-video', attachment: staged.attachment, mediaType: 'video/mp4',
          }]
          const prompt = staged.prompt.trim()
          if (prompt !== '') content.push({ type: 'text', text: prompt })
          agent.steer(createUserMessage({ content, source: { kind: 'user' } }))
          return { kind: 'success' }
        } catch {
          return signal.aborted
            ? { kind: 'error', text: 'Original MP4 submission was cancelled before delivery.' }
            : { kind: 'error', text: 'The original MP4 submission could not be completed.' }
        }
      },
    }))
  })
}
