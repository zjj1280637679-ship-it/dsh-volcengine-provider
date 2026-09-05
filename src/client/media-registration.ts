import type { Context } from '@deepseek-ai/cordis'
import { MediaDock } from './MediaDock.js'
import { createMediaOperations } from './media-operations.js'
import type { MediaServices } from './media-operations.js'

/** Optional new public services are detected structurally, keeping the older image-only host usable. */
export function registerMediaDock(ctx: Context): void {
  ctx.inject(['fileUpload', 'remote.commands', 'remote.llm', 'modelDirectories', 'sessions'], scope => {
    const upload = scope.get('fileUpload') as MediaServices['upload'] | undefined
    const commands = scope.get('remote.commands') as MediaServices['commands'] | undefined
    const llm = scope.get('remote.llm') as MediaServices['llm'] | undefined
    const directories = scope.get('modelDirectories') as { directoryFor(id: string): MediaServices['directory'] } | undefined
    const sessions = scope.get('sessions') as { subagentAddress(id: string): unknown; scope(id: string): unknown } | undefined
    if (typeof upload?.upload !== 'function' || typeof commands?.list !== 'function'
      || typeof commands.execute !== 'function' || typeof llm?.listConfigurableProviders !== 'function'
      || typeof llm.listProviders !== 'function' || typeof directories?.directoryFor !== 'function'
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
    const slots = scope.slots as unknown as {
      inject(name: string, register: () => () => void): void
      register(options: { name: string; id: string; order: number; inject(id: string): object }, component: typeof MediaDock): () => void
    }
    slots.inject('conversation.input.dock', () => slots.register({
      name: 'conversation.input.dock', id: 'volcengine-media', order: 30,
      inject: sessionId => ({ operations: createMediaOperations(sessionId, {
        upload, commands, llm, directory: directories.directoryFor(sessionId),
        canAddress: () => sessions.scope(sessionId) !== undefined && sessions.subagentAddress(sessionId) === undefined,
        generation: generationStore,
      }) }),
    }, MediaDock))
  })
}
