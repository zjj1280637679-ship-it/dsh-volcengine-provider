import { resolveMediaDeclaration } from '../media-declaration.js'
import type {
  MediaDirectoryState, MediaDraftFile, MediaOperations, MediaProgress, MediaSelection, ReadableStore,
} from './media-operations.js'

type Result<T> = { ok: true; value: T } | { ok: false; error: { message: string; code?: string } }

const CHANNEL = '/volcengine-media'
const DISCARD_TIMEOUT_MS = 1_000

export interface LoopbackVideoServices {
  connection: {
    readonly isLoopback: boolean
    readonly rpc: {
      call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<Result<unknown>>
    }
  }
  commands: {
    list(sessionId: string): Promise<Result<readonly { name: string }[]>>
    execute(sessionId: string, line: string, attachments: readonly never[], signal?: AbortSignal): Promise<Result<{
      result: { kind: 'success' | 'error'; text?: string }
    } | undefined>>
  }
  directory: { store: ReadableStore<MediaDirectoryState>; load(): Promise<unknown> }
  canAddress(): boolean
  generation: ReadableStore<number>
}

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

function abort(signal?: AbortSignal): void { signal?.throwIfAborted() }

function same(a: MediaSelection, b: MediaSelection): boolean {
  return a.provider === b.provider && a.model === b.model
}

function validate(files: readonly MediaDraftFile[]): void {
  if (files.length !== 1) throw new Error('The loopback video path accepts exactly one MP4 file.')
  const item = files[0]!
  const declaration = resolveMediaDeclaration(item)
  if (declaration.modality !== 'video' || declaration.mediaType !== 'video/mp4' || declaration.format !== undefined) {
    throw new Error('The loopback video path accepts only an explicitly declared video/mp4 file.')
  }
  if (!Number.isSafeInteger(item.file.size) || item.file.size <= 0) {
    throw new Error('The original MP4 must contain at least 1 byte and report a safe integer size.')
  }
}

function base64Of(data: Uint8Array): string {
  let binary = ''
  const step = 0x8000
  for (let offset = 0; offset < data.byteLength; offset += step) {
    binary += String.fromCharCode(...data.subarray(offset, Math.min(offset + step, data.byteLength)))
  }
  return btoa(binary)
}

function submissionId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
  if (typeof globalThis.crypto?.getRandomValues !== 'function') throw new Error('This browser cannot create a secure media submission id.')
  const data = globalThis.crypto.getRandomValues(new Uint8Array(16))
  return Array.from(data, byte => byte.toString(16).padStart(2, '0')).join('')
}

function tokenResult(value: unknown): { token: string } {
  if (typeof value !== 'object' || value === null) throw new Error('The media staging response was invalid.')
  const token = (value as { token?: unknown }).token
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/u.test(token)) {
    throw new Error('The media staging response was invalid.')
  }
  return { token }
}

function commitResult(value: unknown): { token: string; sha256: string } {
  const result = tokenResult(value)
  const sha256 = (value as { sha256?: unknown }).sha256
  if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(sha256)) {
    throw new Error('The media staging response was invalid.')
  }
  return { ...result, sha256 }
}

function capabilityResult(value: unknown): { chunkBytes: number } {
  if (typeof value !== 'object' || value === null
    || (value as { version?: unknown }).version !== 2
    || !Number.isSafeInteger((value as { chunkBytes?: unknown }).chunkBytes)
    || Number((value as { chunkBytes?: unknown }).chunkBytes) <= 0) {
    throw new Error('The installed provider does not expose the expected original MP4 protocol.')
  }
  return { chunkBytes: Number((value as { chunkBytes: number }).chunkBytes) }
}

/** Cleanup must never keep the user-facing cancellation path busy. */
function discardInBackground(services: LoopbackVideoServices, sessionId: string, token: string): void {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DISCARD_TIMEOUT_MS)
  void Promise.resolve().then(() => services.connection.rpc.call(
    CHANNEL, 'discard', { sessionId, token }, controller.signal,
  ))
    .catch(() => undefined)
    .finally(() => clearTimeout(timer))
}

/** Raw-file compatibility path for rc.2: loopback-fenced chunk RPC, then a token-only command. */
export function createLoopbackVideoOperations(sessionId: string, services: LoopbackVideoServices): MediaOperations {
  let chunkBytes: number | undefined
  const check = async (signal?: AbortSignal): Promise<MediaSelection> => {
    abort(signal)
    if (!services.connection.isLoopback || !services.canAddress()) {
      throw new Error('Original MP4 upload is available only in a local, top-level Harness session.')
    }
    await services.directory.load()
    abort(signal)
    const state = services.directory.store.getSnapshot()
    if (state.current === null || state.routable === false) throw new Error('Select an enabled Volcengine model first.')
    const selected = { ...state.current }
    if (!selected.provider.startsWith('volcengine-') || selected.model.length === 0) {
      throw new Error('Select an enabled Volcengine model first.')
    }
    const [commands, capabilities] = await Promise.all([
      services.commands.list(sessionId),
      services.connection.rpc.call(CHANNEL, 'capabilities', {}, signal),
    ])
    abort(signal)
    if (!unwrap(commands).some(row => row.name === 'ark-media-local')) {
      throw new Error('The installed provider does not expose the original MP4 command.')
    }
    chunkBytes = capabilityResult(unwrap(capabilities)).chunkBytes
    const latest = services.directory.store.getSnapshot().current
    if (latest === null || !same(selected, latest)) throw new Error('The model changed; confirm it and submit again.')
    return selected
  }

  return {
    sessionId,
    mode: 'loopback-video',
    maxFiles: 1,
    selection: services.directory.store,
    generation: services.generation,
    validate,
    check,
    async send(files: readonly MediaDraftFile[], prompt: string, signal: AbortSignal,
      progress: (value: MediaProgress) => void): Promise<void> {
      validate(files)
      const generation = services.generation.getSnapshot()
      const initial = services.directory.store.getSnapshot().current
      const selected = await check(signal)
      if (initial === null || !same(initial, selected)) throw new Error('The model changed; confirm it and submit again.')
      const item = files[0]!
      abort(signal)
      if (generation !== services.generation.getSnapshot()) throw new Error('The connection changed; submit the retained file again.')
      const current = services.directory.store.getSnapshot().current
      if (current === null || !same(selected, current)) throw new Error('The model changed; confirm it and submit again.')
      if (chunkBytes === undefined) throw new Error('The original MP4 protocol was not initialized.')

      let token: string | undefined
      try {
        token = tokenResult(unwrap(await services.connection.rpc.call(CHANNEL, 'begin', {
          sessionId,
          name: item.file.name,
          mediaType: 'video/mp4',
          bytes: item.file.size,
          prompt,
          clientSubmissionId: submissionId(),
          expectedProvider: selected.provider,
          expectedModel: selected.model,
        }, signal))).token
        let offset = 0
        while (offset < item.file.size) {
          abort(signal)
          if (generation !== services.generation.getSnapshot()) {
            throw new Error('The connection changed; submit the retained file again.')
          }
          const latest = services.directory.store.getSnapshot().current
          if (latest === null || !same(selected, latest)) throw new Error('The model changed; confirm it and submit again.')
          const end = Math.min(offset + chunkBytes, item.file.size)
          const data = new Uint8Array(await item.file.slice(offset, end).arrayBuffer())
          abort(signal)
          unwrap(await services.connection.rpc.call(CHANNEL, 'append', {
            sessionId, token, offset, data: base64Of(data),
          }, signal))
          offset = end
          progress({ name: item.file.name, loaded: offset, total: item.file.size })
        }
        const committed = commitResult(unwrap(await services.connection.rpc.call(
          CHANNEL, 'commit', { sessionId, token }, signal,
        )))
        if (committed.token !== token) throw new Error('The committed MP4 token did not match the upload.')
        abort(signal)
        const confirmed = await check(signal)
        if (!same(selected, confirmed)) throw new Error('The model changed; confirm it and submit again.')
        let execution: { result: { kind: 'success' | 'error'; text?: string } } | undefined
        try {
          execution = unwrap(await services.commands.execute(sessionId, `/ark-media-local ${token}`, [], signal))
        } catch (error) {
          throw new Error('Submission state is unknown. Check the session before deciding whether to retry.', { cause: error })
        }
        if (execution === undefined) throw new Error('The original MP4 command is unavailable; the selected file is retained.')
        if (execution.result.kind !== 'success') throw new Error(execution.result.text ?? 'The original MP4 submission failed.')
      } finally {
        if (token !== undefined) discardInBackground(services, sessionId, token)
        // A rejected command response can arrive after the Host accepted it. Never retry here.
      }
    },
  }
}
