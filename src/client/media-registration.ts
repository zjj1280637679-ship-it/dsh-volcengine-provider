import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'

import { hasMethods, hasSlotRegistry } from '../host-compat.js'
import { MediaAttachments, MediaPlus } from './MediaPlus.js'
import {
  NativeMediaDraftBridge,
  type NativeMediaClientServices,
} from './native-media-upload.js'

function hasLoopbackConnection(value: unknown): value is NativeMediaClientServices['connection'] {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { isLoopback?: unknown; rpc?: unknown }
  return candidate.isLoopback === true && hasMethods(candidate.rpc, ['call'])
}

interface PublicConnectionLifecycleSource {
  getSnapshot(): unknown
  subscribe(listener: () => void): () => void
}

export type ConnectionGenerationClock = NativeMediaClientServices['generation'] & {
  /** Public Host capability selected for this Harness generation. */
  readonly source: 'generation' | 'hostDescription'
  dispose(): void
}

function hasLifecycleSource(value: unknown): value is PublicConnectionLifecycleSource {
  return hasMethods(value, ['getSnapshot', 'subscribe'])
}

/**
 * Convert both published Connection lifecycles into one monotone upload clock.
 * 0.1.2 exposes `generation`; 0.1.1 exposes `hostDescription`. A source
 * notification means establishment, loss, or replacement and invalidates all
 * work admitted under the preceding clock value.
 */
export function createConnectionGenerationClock(connection: unknown): ConnectionGenerationClock | undefined {
  if (typeof connection !== 'object' || connection === null) return undefined
  // This structural union is intentional: no single ConnectionHandle release
  // declares both names, but both are public observable stores in their line.
  const candidate = connection as Pick<ConnectionHandle, 'isLoopback' | 'rpc'> & {
    readonly generation?: unknown
    readonly hostDescription?: unknown
  }
  const selected = hasLifecycleSource(candidate.generation)
    ? { source: 'generation' as const, store: candidate.generation }
    : hasLifecycleSource(candidate.hostDescription)
      ? { source: 'hostDescription' as const, store: candidate.hostDescription }
      : undefined
  if (selected === undefined) return undefined

  let value = 0
  const listeners = new Set<() => void>()
  let stop: (() => void) | undefined
  try {
    selected.store.getSnapshot()
    stop = selected.store.subscribe(() => {
      value += 1
      for (const listener of [...listeners]) listener()
    })
  } catch {
    return undefined
  }
  if (typeof stop !== 'function') return undefined
  let disposed = false
  return {
    source: selected.source,
    getSnapshot: () => value,
    subscribe: listener => {
      if (disposed) return () => {}
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      listeners.clear()
      stop()
    },
  }
}

function hasDirectories(value: unknown): value is NativeMediaClientServices['directories'] {
  return hasMethods(value, ['directoryFor'])
}

function hasSessions(value: unknown): value is NativeMediaClientServices['sessions'] {
  return hasMethods(value, ['scope', 'subagentAddress'])
}

function hasConversationInput(value: unknown): value is NativeMediaClientServices['conversation'] {
  if (typeof value !== 'object' || value === null) return false
  return hasMethods((value as { input?: unknown }).input, ['for'])
}

function hasInputTriggers(value: unknown): value is NativeMediaClientServices['inputTriggers'] {
  return hasMethods(value, ['registerSource'])
}

/** Mount only the input-side-path capabilities that the running Harness actually publishes. */
export function registerMediaPlus(ctx: Context): void {
  ctx.inject(['connection', 'modelDirectories', 'sessions', 'conversation', 'inputTriggers'], scope => {
    const connection = scope.get('connection')
    const directories = scope.get('modelDirectories')
    const sessions = scope.get('sessions')
    const conversation = scope.get('conversation')
    const inputTriggers = scope.get('inputTriggers')
    if (!hasLoopbackConnection(connection) || !hasDirectories(directories)
      || !hasSessions(sessions) || !hasConversationInput(conversation)
      || !hasInputTriggers(inputTriggers)) {
      scope.logger.warn('dsh-volcengine-provider: native media plus disabled because the current Host lacks its public input-side-path capabilities')
      return
    }
    const slots = scope.get('slots')
    if (!hasSlotRegistry(slots)) return

    const generationStore = createConnectionGenerationClock(connection)
    if (generationStore === undefined) {
      scope.logger.warn('dsh-volcengine-provider: native media plus disabled because Connection publishes no supported lifecycle state source')
      return
    }

    const bridge = new NativeMediaDraftBridge({
      connection, directories, sessions, conversation, inputTriggers, generation: generationStore,
    })
    scope.effect(() => {
      const stopBridge = bridge.register()
      return () => {
        try { stopBridge() } finally { generationStore.dispose() }
      }
    })
    const mediaSlots = slots as unknown as {
      inject(name: string, register: () => () => void): void
      register(options: {
        name: string
        id: string
        order: number
        inject(sessionId: string): { operations: ReturnType<NativeMediaDraftBridge['operations']> }
      }, component: typeof MediaPlus): () => void
    }
    mediaSlots.inject('conversation.input.left', () => mediaSlots.register({
      name: 'conversation.input.left',
      id: 'volcengine-native-media-plus',
      order: 31,
      inject: sessionId => ({ operations: bridge.operations(sessionId) }),
    }, MediaPlus))
    mediaSlots.inject('conversation.input.dock', () => mediaSlots.register({
      name: 'conversation.input.dock',
      id: 'volcengine-native-media-details',
      order: 31,
      inject: sessionId => ({ operations: bridge.operations(sessionId) }),
    }, MediaAttachments))
  })
}
