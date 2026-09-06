import type { Context } from '@deepseek-ai/cordis'
import {
  freezeMessage,
  type ContentBlock,
  type UserMessage,
} from '@deepseek-ai/dsh-llm'

import { selectedModel } from './media-command.js'
import {
  nativeMediaMarkerOccurrences,
  parseLeadingNativeMediaMarkers,
} from './native-media-marker.js'
import type {
  MaterializedNativeMediaBundle,
  NativeMediaBundleStatus,
  NativeMediaClaim,
} from './native-media-staging.js'

export type NativeMediaFallbackCode =
  | 'BUNDLE_UNAVAILABLE'
  | 'DUPLICATE_REFERENCE'
  | 'MEDIA_UNAVAILABLE'
  | 'MALFORMED_REFERENCE'
  | 'ROUTE_CHANGED'
  | 'ROUTE_UNAVAILABLE'
  | 'UNTRUSTED_SOURCE'

export interface NativeMediaMergeAgent {
  readonly id: string
  readonly session: {
    readonly id: string
    requestHeader(): {
      readonly config: { readonly provider: string; readonly model?: string }
    } | undefined
  }
  steer(message: UserMessage): void
}

/** The narrow server-side surface used by the exact-message merge layer. */
export interface NativeMediaMergeStaging {
  status(
    sessionId: string,
    bundleId: string,
    signal?: AbortSignal,
  ): Promise<NativeMediaBundleStatus | undefined>
  claimMany(
    sessionId: string,
    bundleIds: readonly string[],
    messageId: string,
    signal?: AbortSignal,
  ): Promise<readonly NativeMediaClaim[] | undefined>
  materialize(
    sessionId: string,
    bundleId: string,
    messageId: string,
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<MaterializedNativeMediaBundle | undefined>
  confirm(sessionId: string, bundleId: string, messageId: string): Promise<boolean>
  /** Retire only an unclaimed draft bundle; another message's claim stays intact. */
  discard(sessionId: string, bundleId: string, signal?: AbortSignal): Promise<boolean>
  discardClaim(
    sessionId: string,
    bundleId: string,
    messageId: string,
    signal?: AbortSignal,
  ): Promise<boolean>
}

type PreStepDecision =
  | { readonly kind: 'reject' }
  | { readonly kind: 'enter'; readonly messages: UserMessage[] }

interface NativeMediaPreStepPayload {
  readonly agent: NativeMediaMergeAgent
  readonly messages: UserMessage[]
  readonly turn: number
  readonly step: number
  readonly signal: AbortSignal
}

interface SessionLike {
  readonly id: string
}

interface SessionEventLike {
  readonly type: string
  readonly data: unknown
}

interface NativeMediaEventContext {
  on(
    name: 'agent/pre-step',
    listener: (
      payload: NativeMediaPreStepPayload,
      next: () => Promise<PreStepDecision>,
    ) => Promise<PreStepDecision>,
    options?: { readonly prepend?: boolean },
  ): unknown
  on(
    name: 'session/event',
    listener: (session: SessionLike, event: SessionEventLike) => void,
  ): unknown
}

interface PendingConfirmation {
  readonly sessionId: string
  readonly messageId: string
  readonly bundleIds: readonly string[]
  readonly contentJson: string
}

const FALLBACK_CLEANUP_TIMEOUT_MS = 2_000

function confirmationKey(sessionId: string, messageId: string): string {
  return `${sessionId}\u0000${messageId}`
}

function fallbackDiagnostic(code: NativeMediaFallbackCode): string {
  const reasons: Record<NativeMediaFallbackCode, string> = {
    BUNDLE_UNAVAILABLE: '附件已失效',
    DUPLICATE_REFERENCE: '附件重复',
    MEDIA_UNAVAILABLE: '无法读取附件',
    MALFORMED_REFERENCE: '附件位置或引用无效',
    ROUTE_CHANGED: '所选模型已改变',
    ROUTE_UNAVAILABLE: '方舟模型不可用',
    UNTRUSTED_SOURCE: '附件不属于当前输入',
  }
  return `[本条附件未发送：${reasons[code]}。请重新添加。]`
}

function markerIds(message: UserMessage): string[] {
  return message.content.flatMap(block => block.type === 'text'
    ? nativeMediaMarkerOccurrences(block.text).map(occurrence => occurrence.bundleId)
    : [])
}

function leadingMarkerIds(message: UserMessage): string[] {
  return parseLeadingNativeMediaMarkers(message.content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join(''))
}

/**
 * Remove every canonical marker and put one bounded diagnostic at the first
 * marker position. The user's other blocks and every non-marker text byte stay
 * in the same order, so media failure cannot turn accepted text into rejection.
 */
function fallbackMessage(message: UserMessage, code: NativeMediaFallbackCode): UserMessage {
  const diagnostic = fallbackDiagnostic(code)
  let inserted = false
  const content: ContentBlock[] = []

  for (const block of message.content) {
    if (block.type !== 'text') {
      content.push(block)
      continue
    }
    const occurrences = nativeMediaMarkerOccurrences(block.text)
    if (occurrences.length === 0) {
      content.push(block)
      continue
    }
    let cursor = 0
    let text = ''
    for (const occurrence of occurrences) {
      text += block.text.slice(cursor, occurrence.start)
      if (!inserted) {
        text += diagnostic
        inserted = true
      }
      cursor = occurrence.end
    }
    text += block.text.slice(cursor)
    if (text !== '') content.push({ type: 'text', text })
  }
  if (!inserted) content.push({ type: 'text', text: diagnostic })
  return freezeMessage({ ...message, content })
}

function mediaBlocks(bundle: MaterializedNativeMediaBundle): ContentBlock[] {
  return bundle.files.map((file): ContentBlock => {
    if (file.modality === 'image') {
      return {
        type: 'volcengine-image',
        attachment: file.attachment,
        mediaType: file.mediaType,
      }
    }
    if (file.modality === 'video') {
      return {
        type: 'volcengine-video',
        attachment: file.attachment,
        mediaType: file.mediaType,
      }
    }
    return {
      type: 'volcengine-audio',
      attachment: file.attachment,
      mediaType: file.mediaType,
      ...(file.format === undefined ? {} : { format: file.format }),
    }
  })
}

/** Replace markers in-place, yielding one identified message for one request. */
function mergedMessage(
  message: UserMessage,
  materialized: ReadonlyMap<string, MaterializedNativeMediaBundle>,
): UserMessage {
  const content: ContentBlock[] = []
  for (const block of message.content) {
    if (block.type !== 'text') {
      content.push(block)
      continue
    }
    const occurrences = nativeMediaMarkerOccurrences(block.text)
    if (occurrences.length === 0) {
      content.push(block)
      continue
    }
    let cursor = 0
    for (const occurrence of occurrences) {
      const before = block.text.slice(cursor, occurrence.start)
      if (before !== '') content.push({ type: 'text', text: before })
      content.push(...mediaBlocks(materialized.get(occurrence.bundleId)!))
      cursor = occurrence.end
    }
    const after = block.text.slice(cursor)
    if (after !== '') content.push({ type: 'text', text: after })
  }
  return freezeMessage({ ...message, content })
}

function isCurrentSelection(
  value: { readonly provider: string; readonly model?: string } | undefined,
  provider: string,
  model: string,
  isOwnedProvider: (provider: string) => boolean,
): boolean {
  return value?.provider === provider && value.model === model && isOwnedProvider(provider)
}

/**
 * Exact-message, server-side bridge from the native composer marker to Ark
 * content blocks. It never creates another UserMessage and never rejects an
 * already accepted text prompt because media preparation failed.
 */
export class NativeMediaMessageMerger {
  private readonly pending = new Map<string, PendingConfirmation>()
  private readonly confirmations = new Set<Promise<void>>()
  private readonly fallbackCleanups = new Set<Promise<void>>()

  constructor(
    readonly ctx: Context,
    readonly staging: NativeMediaMergeStaging,
    readonly isOwnedProvider: (provider: string) => boolean,
  ) {}

  private fallback(message: UserMessage, code: NativeMediaFallbackCode): UserMessage {
    try {
      this.ctx.logger.warn(`dsh-volcengine-provider: native media omitted (${code})`)
    } catch {
      // A diagnostic sink failure must not block an already accepted message.
    }
    return fallbackMessage(message, code)
  }

  private remember(
    sessionId: string,
    messageId: string,
    bundleIds: readonly string[],
    message: UserMessage,
  ): void {
    this.pending.set(confirmationKey(sessionId, messageId), {
      sessionId,
      messageId,
      bundleIds,
      contentJson: JSON.stringify(message.content),
    })
  }

  private async cleanup(
    sessionId: string,
    messageId: string,
    bundleIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<void> {
    await Promise.allSettled([...new Set(bundleIds)].map(async bundleId => {
      if (await this.staging.discardClaim(sessionId, bundleId, messageId, signal)) return
      await this.staging.discard(sessionId, bundleId, signal)
    }))
  }

  /** Cleanup must never sit in front of an already accepted text message. */
  private cleanupAfterFallback(
    sessionId: string,
    messageId: string,
    bundleIds: readonly string[],
  ): void {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FALLBACK_CLEANUP_TIMEOUT_MS)
    let operation!: Promise<void>
    operation = this.cleanup(sessionId, messageId, bundleIds, controller.signal)
      .catch(() => {
        this.ctx.logger.warn('dsh-volcengine-provider: native media fallback cleanup failed')
      })
      .finally(() => {
        clearTimeout(timer)
        this.fallbackCleanups.delete(operation)
      })
    this.fallbackCleanups.add(operation)
  }

  private async mergeOne(
    agent: NativeMediaMergeAgent,
    message: UserMessage,
    signal: AbortSignal,
  ): Promise<UserMessage> {
    const bundleIds = markerIds(message)
    if (bundleIds.length === 0) return message
    const sessionId = String(agent.session.id)
    const messageId = String(message.id)
    const fail = (code: NativeMediaFallbackCode): UserMessage => {
      this.cleanupAfterFallback(sessionId, messageId, bundleIds)
      return this.fallback(message, code)
    }

    if (message.source.kind !== 'user') return fail('UNTRUSTED_SOURCE')
    const leading = leadingMarkerIds(message)
    if (leading.length !== bundleIds.length
      || leading.some((bundleId, index) => bundleId !== bundleIds[index])) {
      return fail('MALFORMED_REFERENCE')
    }
    if (new Set(bundleIds).size !== bundleIds.length) return fail('DUPLICATE_REFERENCE')

    let selection: ReturnType<typeof selectedModel>
    try {
      selection = selectedModel(this.ctx, agent)
      if (selection === undefined || selection.model === undefined
        || selection.provider === '' || selection.model === ''
        || !this.isOwnedProvider(selection.provider)) return fail('ROUTE_UNAVAILABLE')

      const statuses = await Promise.allSettled(bundleIds.map(bundleId => (
        this.staging.status(sessionId, bundleId, signal)
      )))
      if (statuses.some((result, index) => result.status === 'rejected'
        || result.value === undefined || result.value.bundleId !== bundleIds[index])) {
        return fail('BUNDLE_UNAVAILABLE')
      }
      if (statuses.some(result => result.status === 'fulfilled'
        && (result.value!.expectedProvider !== selection!.provider
          || result.value!.expectedModel !== selection!.model))) {
        return fail('ROUTE_CHANGED')
      }

      const claims = await this.staging.claimMany(
        sessionId, bundleIds, messageId, signal,
      )
      if (claims === undefined || claims.length !== bundleIds.length
        || claims.some((claim, index) => claim.bundleId !== bundleIds[index]
          || claim.sessionId !== sessionId || claim.messageId !== messageId)) {
        return fail('BUNDLE_UNAVAILABLE')
      }

      const results = await Promise.allSettled(bundleIds.map(bundleId => this.staging.materialize(
        sessionId, bundleId, messageId, selection!.provider, selection!.model!, signal,
      )))
      if (results.some((result, index) => result.status === 'rejected'
        || result.value === undefined || result.value.bundleId !== bundleIds[index]
        || result.value.sessionId !== sessionId || result.value.messageId !== messageId
        || result.value.expectedProvider !== selection!.provider
        || result.value.expectedModel !== selection!.model)) {
        return fail('MEDIA_UNAVAILABLE')
      }

      const latest = selectedModel(this.ctx, agent)
      if (!isCurrentSelection(
        latest, selection.provider, selection.model, this.isOwnedProvider,
      )) return fail('ROUTE_CHANGED')

      const byBundle = new Map(results.map((result, index) => [
        bundleIds[index]!,
        (result as PromiseFulfilledResult<MaterializedNativeMediaBundle>).value,
      ]))
      const merged = mergedMessage(message, byBundle)
      this.remember(sessionId, messageId, bundleIds, merged)
      return merged
    } catch {
      return fail('MEDIA_UNAVAILABLE')
    }
  }

  async merge(
    agent: NativeMediaMergeAgent,
    messages: readonly UserMessage[],
    signal: AbortSignal,
  ): Promise<UserMessage[]> {
    const merged: UserMessage[] = []
    for (const message of messages) {
      try {
        merged.push(await this.mergeOne(agent, message, signal))
      } catch {
        // This last containment boundary deliberately performs no staging I/O:
        // an unavailable cleanup path must still remove transport markers and
        // preserve the already accepted message text.
        merged.push(markerIds(message).length === 0
          ? message
          : this.fallback(message, 'MEDIA_UNAVAILABLE'))
      }
    }
    return merged
  }

  observeSessionEvent(session: SessionLike, event: SessionEventLike): void {
    if (event.type !== 'user/message' || typeof event.data !== 'object'
      || event.data === null || !('id' in event.data)
      || typeof event.data.id !== 'string') return
    const key = confirmationKey(String(session.id), event.data.id)
    const pending = this.pending.get(key)
    if (pending === undefined) return
    this.pending.delete(key)

    let confirmation!: Promise<void>
    const exactContent = 'content' in event.data && Array.isArray(event.data.content)
      && JSON.stringify(event.data.content) === pending.contentJson
    const operation = exactContent
      ? Promise.allSettled(pending.bundleIds.map(bundleId => this.staging.confirm(
        pending.sessionId, bundleId, pending.messageId,
      ))).then(results => {
        if (results.some(result => result.status === 'rejected' || result.value !== true)) {
          this.ctx.logger.warn('dsh-volcengine-provider: a durable native media bundle could not be retired')
        }
      })
      : this.cleanup(pending.sessionId, pending.messageId, pending.bundleIds).then(() => {
        this.ctx.logger.warn('dsh-volcengine-provider: durable native media content did not match its accepted message')
      })
    confirmation = operation.catch(() => {
      this.ctx.logger.warn('dsh-volcengine-provider: native media confirmation failed')
    }).finally(() => {
      this.confirmations.delete(confirmation)
    })
    this.confirmations.add(confirmation)
  }

  /** Await only already-started durable-event confirmations (primarily for lifecycle tests). */
  async whenConfirmationsIdle(): Promise<void> {
    while (this.confirmations.size > 0 || this.fallbackCleanups.size > 0) {
      await Promise.all([...this.confirmations, ...this.fallbackCleanups])
    }
  }
}

/** Wrap the waterfall and merge only after downstream pre-step acceptance. */
export function registerNativeMediaMerge(
  ctx: Context,
  staging: NativeMediaMergeStaging,
  isOwnedProvider: (provider: string) => boolean,
): NativeMediaMessageMerger {
  const merger = new NativeMediaMessageMerger(ctx, staging, isOwnedProvider)
  const events = ctx as unknown as NativeMediaEventContext
  events.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    return {
      kind: 'enter',
      messages: await merger.merge(agent, decision.messages, signal),
    }
  }, { prepend: true })
  events.on('session/event', (session, event) => {
    merger.observeSessionEvent(session, event)
  })
  return merger
}
