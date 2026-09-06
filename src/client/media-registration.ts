import type { Context } from '@deepseek-ai/cordis'

import { hasMethods, hasSlotRegistry } from '../host-compat.js'
import { MediaPlus } from './MediaPlus.js'
import {
  NativeMediaDraftBridge,
  type NativeMediaClientServices,
} from './native-media-upload.js'

function hasLoopbackConnection(value: unknown): value is NativeMediaClientServices['connection'] {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { isLoopback?: unknown; rpc?: unknown }
  return candidate.isLoopback === true && hasMethods(candidate.rpc, ['call'])
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

    let generation = 0
    const generationListeners = new Set<() => void>()
    const generationStore: NativeMediaClientServices['generation'] = {
      getSnapshot: () => generation,
      subscribe: listener => {
        generationListeners.add(listener)
        return () => { generationListeners.delete(listener) }
      },
    }
    scope.on('connection/reset' as never, (() => {
      generation += 1
      for (const listener of [...generationListeners]) listener()
    }) as never)

    const bridge = new NativeMediaDraftBridge({
      connection, directories, sessions, conversation, inputTriggers, generation: generationStore,
    })
    scope.effect(() => bridge.register())
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
  })
}
