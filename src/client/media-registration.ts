import type { Context } from '@deepseek-ai/cordis'
import { MediaDock } from './MediaDock.js'
import { createMediaOperations } from './media-operations.js'
import type { MediaServices } from './media-operations.js'
import { createLoopbackVideoOperations, type LoopbackVideoServices } from './media-fallback-upload.js'
import { hasSlotRegistry } from '../host-compat.js'

/** Optional new public services are detected structurally, keeping the older image-only host usable. */
export function registerMediaDock(ctx: Context): void {
  ctx.inject(['remote.commands', 'modelDirectories', 'sessions'], scope => {
    const commands = scope.get('remote.commands') as MediaServices['commands'] | undefined
    const directories = scope.get('modelDirectories') as { directoryFor(id: string): MediaServices['directory'] } | undefined
    const sessions = scope.get('sessions') as { subagentAddress(id: string): unknown; scope(id: string): unknown } | undefined
    if (typeof commands?.list !== 'function'
      || typeof commands.execute !== 'function' || typeof directories?.directoryFor !== 'function'
      || typeof sessions?.subagentAddress !== 'function' || typeof sessions.scope !== 'function') return
    let generation = 0
    const generationListeners = new Set<() => void>()
    const generationStore: MediaServices['generation'] = {
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
    // The slot is a published list/session face. Keep its optional contract out of baseline type dependencies.
    const slots = scope.get('slots')
    if (!hasSlotRegistry(slots)) return
    const mediaSlots = slots as unknown as {
      inject(name: string, register: () => () => void): void
      register(options: { name: string; id: string; order: number; inject(id: string): object }, component: typeof MediaDock): () => void
    }
    const common = (sessionId: string) => ({
      commands, directory: directories.directoryFor(sessionId),
      canAddress: () => sessions.scope(sessionId) !== undefined && sessions.subagentAddress(sessionId) === undefined,
      generation: generationStore,
    })
    let upload: MediaServices['upload'] | undefined
    let connection: LoopbackVideoServices['connection'] | undefined
    let seat = false
    let registration: (() => void) | undefined
    const hasHostUpload = (): boolean => typeof upload?.upload === 'function' && upload.available
    const disposeRegistration = (): void => { registration?.(); registration = undefined }
    const reconcile = (): void => {
      disposeRegistration()
      if (!seat || (!hasHostUpload() && connection?.isLoopback !== true)) return
      registration = mediaSlots.register({
        name: 'conversation.input.dock', id: 'volcengine-media', order: 30,
        // Read the optional service at injection time as well: a Host update can
        // replace fileUpload without replacing the stable conversation slot.
        inject: sessionId => ({ operations: hasHostUpload()
          ? createMediaOperations(sessionId, { upload: upload!, ...common(sessionId) })
          : createLoopbackVideoOperations(sessionId, {
            connection: connection!, ...common(sessionId),
          } as LoopbackVideoServices) }),
      }, MediaDock)
    }
    scope.inject(['fileUpload'], uploadScope => {
      const candidate = uploadScope.get('fileUpload') as MediaServices['upload'] | undefined
      if (typeof candidate?.upload !== 'function') return
      upload = candidate
      reconcile()
      return () => {
        if (upload === candidate) upload = undefined
        reconcile()
      }
    })
    scope.inject(['connection'], connectionScope => {
      const candidate = connectionScope.get('connection') as LoopbackVideoServices['connection'] | undefined
      if (typeof candidate?.rpc?.call !== 'function') return
      connection = candidate
      reconcile()
      return () => {
        if (connection === candidate) connection = undefined
        reconcile()
      }
    })
    mediaSlots.inject('conversation.input.dock', () => {
      seat = true
      reconcile()
      return () => { seat = false; disposeRegistration() }
    })
  })
}
