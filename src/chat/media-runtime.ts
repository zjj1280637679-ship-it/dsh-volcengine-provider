import { constants as bufferConstants } from 'node:buffer'
import { freemem } from 'node:os'
import { getHeapStatistics } from 'node:v8'

import { LlmError } from '@deepseek-ai/dsh-llm'

export interface MediaRequestFootprint {
  /** Number of attachment-backed blocks that will reach the generated body. */
  readonly mediaCount: number
  /** Sum of the attachment providers' declared raw byte lengths. */
  readonly declaredBytes: number
  /** Sum of the corresponding canonical base64 character counts. */
  readonly base64Bytes: number
}

export interface MediaRuntimeMemory {
  readonly heapHeadroomBytes: number
  readonly systemFreeBytes: number
}

export type InspectMediaRuntimeMemory = () => MediaRuntimeMemory

interface SlotWaiter {
  readonly signal?: AbortSignal
  readonly resolve: (release: () => void) => void
  readonly reject: (cause: unknown) => void
  readonly aborted: () => void
}

interface ProcessMediaGate {
  active: boolean
  readonly queue: SlotWaiter[]
}

const PROCESS_MEDIA_GATE_KEY = Symbol.for('dsh-volcengine-provider.media-request-gate.v1')
const existingGate = Reflect.get(globalThis, PROCESS_MEDIA_GATE_KEY) as ProcessMediaGate | undefined
const processMediaGate: ProcessMediaGate = existingGate ?? { active: false, queue: [] }
if (existingGate === undefined) {
  Object.defineProperty(globalThis, PROCESS_MEDIA_GATE_KEY, {
    value: processMediaGate,
    configurable: false,
    enumerable: false,
    writable: false,
  })
}

function removeWaiter(waiter: SlotWaiter): void {
  const index = processMediaGate.queue.indexOf(waiter)
  if (index >= 0) processMediaGate.queue.splice(index, 1)
}

function releaseForActiveSlot(): () => void {
  let active = true
  return () => {
    if (!active) return
    active = false
    for (;;) {
      const waiter = processMediaGate.queue.shift()
      if (waiter === undefined) {
        processMediaGate.active = false
        return
      }
      waiter.signal?.removeEventListener('abort', waiter.aborted)
      if (waiter.signal?.aborted) {
        waiter.reject(waiter.signal.reason)
        continue
      }
      waiter.resolve(releaseForActiveSlot())
      return
    }
  }
}

function acquireProcessMediaSlot(signal?: AbortSignal): Promise<() => void> {
  signal?.throwIfAborted()
  if (!processMediaGate.active) {
    processMediaGate.active = true
    return Promise.resolve(releaseForActiveSlot())
  }
  return new Promise((resolve, reject) => {
    let waiter!: SlotWaiter
    const aborted = (): void => {
      removeWaiter(waiter)
      reject(signal?.reason)
    }
    waiter = { signal, resolve, reject, aborted }
    processMediaGate.queue.push(waiter)
    signal?.addEventListener('abort', aborted, { once: true })
  })
}

function currentRuntimeMemory(): MediaRuntimeMemory {
  const heap = getHeapStatistics()
  const usedHeap = process.memoryUsage().heapUsed
  const hardHeadroom = Math.max(0, heap.heap_size_limit - usedHeap)
  return {
    heapHeadroomBytes: Math.max(0, Math.min(hardHeadroom, heap.total_available_size)),
    systemFreeBytes: freemem(),
  }
}

function safeBytes(value: number): bigint | undefined {
  return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : undefined
}

function assertRuntimeCapacity(
  footprint: MediaRequestFootprint,
  inspectMemory: InspectMediaRuntimeMemory,
): void {
  const declared = safeBytes(footprint.declaredBytes)
  const base64 = safeBytes(footprint.base64Bytes)
  if (declared === undefined || base64 === undefined
    || !Number.isSafeInteger(footprint.mediaCount) || footprint.mediaCount <= 0) {
    throw new LlmError('The declared media request size is invalid.', 'INVALID_MEDIA_SIZE')
  }
  // Each attachment may be individually representable while their combined
  // base64 is not. JSON.stringify must create one request string, so reject
  // this runtime implementation boundary before reading any attachment. This
  // is Node's physical string limit, not a plugin-defined media-size policy.
  if (base64 >= BigInt(bufferConstants.MAX_STRING_LENGTH)) {
    throw new LlmError(
      'The combined media encoding cannot be represented by this Node.js runtime.',
      'MEDIA_SIZE_UNREPRESENTABLE',
    )
  }

  const snapshot = inspectMemory()
  const heapHeadroom = safeBytes(snapshot.heapHeadroomBytes)
  const systemFree = safeBytes(snapshot.systemFreeBytes)
  if (heapHeadroom === undefined || systemFree === undefined) {
    throw new LlmError(
      'The live memory available for media encoding could not be determined safely.',
      'MEDIA_RESOURCE_EXHAUSTED',
    )
  }

  // The original bytes, base64/data-URL strings, JSON string and fetch's body
  // representation may coexist. These multipliers describe that transient
  // encoding peak; they are not media-size limits. Retaining one quarter of
  // both live pools prevents the estimate from consuming all observed slack.
  const requiredHeap = base64 * 3n
  const requiredSystem = declared + base64 * 4n
  const heapFits = requiredHeap * 4n <= heapHeadroom * 3n
  const systemFits = requiredSystem * 4n <= systemFree * 3n
  if (!heapFits || !systemFits) {
    throw new LlmError(
      'This process does not currently have enough live memory headroom to encode the declared media request safely. The source media was not modified.',
      'MEDIA_RESOURCE_EXHAUSTED',
    )
  }
}

/**
 * Acquire the one process-wide media encoding slot and perform a live,
 * request-specific memory admission check. Waiting has no timeout and remains
 * independently cancellable through the caller's signal.
 */
export async function acquireMediaRequest(
  footprint: MediaRequestFootprint,
  signal?: AbortSignal,
  inspectMemory: InspectMediaRuntimeMemory = currentRuntimeMemory,
): Promise<() => void> {
  const release = await acquireProcessMediaSlot(signal)
  try {
    signal?.throwIfAborted()
    assertRuntimeCapacity(footprint, inspectMemory)
    signal?.throwIfAborted()
    return release
  } catch (cause) {
    release()
    throw cause
  }
}
