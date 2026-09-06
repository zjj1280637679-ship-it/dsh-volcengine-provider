import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'

import {
  createConnectionGenerationClock,
  registerMediaPlus,
} from '../../src/client/media-registration.js'

function lifecycleStore(initial: unknown) {
  let value = initial
  const listeners = new Set<() => void>()
  const stop = vi.fn()
  return {
    getSnapshot: () => value,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener); stop() }
    },
    publish(next: unknown) {
      value = next
      for (const listener of [...listeners]) listener()
    },
    stop,
  }
}

describe('native media Connection lifecycle adaptation', () => {
  it('prefers the 0.1.2 generation source and invalidates on establish, loss, and replacement', () => {
    const generation = lifecycleStore(undefined)
    const hostDescription = lifecycleStore({ home: 'legacy' })
    const clock = createConnectionGenerationClock({ generation, hostDescription })
    expect(clock?.source).toBe('generation')
    const changed = vi.fn()
    const off = clock!.subscribe(changed)

    generation.publish({ id: 1, host: { home: 'one' } })
    generation.publish(undefined)
    generation.publish({ id: 2, host: { home: 'two' } })
    expect(clock!.getSnapshot()).toBe(3)
    expect(changed).toHaveBeenCalledTimes(3)
    expect(hostDescription.stop).not.toHaveBeenCalled()

    off()
    clock!.dispose()
    expect(generation.stop).toHaveBeenCalledOnce()
  })

  it('adapts the 0.1.1 hostDescription lifecycle when generation is absent', () => {
    const hostDescription = lifecycleStore(undefined)
    const clock = createConnectionGenerationClock({ hostDescription })
    expect(clock?.source).toBe('hostDescription')
    hostDescription.publish({ home: 'connected' })
    hostDescription.publish(undefined)
    hostDescription.publish({ home: 'reconnected' })
    expect(clock?.getSnapshot()).toBe(3)
    clock?.dispose()
    expect(hostDescription.stop).toHaveBeenCalledOnce()
  })

  it('returns no clock for an unpublished or malformed lifecycle source', () => {
    expect(createConnectionGenerationClock({})).toBeUndefined()
    expect(createConnectionGenerationClock({ generation: { getSnapshot: () => undefined } })).toBeUndefined()
    expect(createConnectionGenerationClock({ hostDescription: { subscribe: () => () => {} } })).toBeUndefined()
    expect(createConnectionGenerationClock({
      generation: { getSnapshot: () => undefined, subscribe: () => undefined },
    })).toBeUndefined()
  })

  it('does not mount the plus when Connection has no public lifecycle source', () => {
    const warn = vi.fn()
    const injectSlot = vi.fn()
    const services: Record<string, unknown> = {
      connection: { isLoopback: true, rpc: { call: vi.fn() } },
      modelDirectories: { directoryFor: vi.fn() },
      sessions: { scope: vi.fn(), subagentAddress: vi.fn() },
      conversation: { input: { for: vi.fn() } },
      inputTriggers: { registerSource: vi.fn() },
      slots: { inject: injectSlot, register: vi.fn() },
    }
    const scope = {
      get: (name: string) => services[name],
      logger: { warn },
      effect: vi.fn(),
    }
    const ctx = {
      inject: (_dependencies: readonly string[], callback: (value: typeof scope) => void) => callback(scope),
    } as unknown as Context

    registerMediaPlus(ctx)

    expect(injectSlot).not.toHaveBeenCalled()
    expect(scope.effect).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no supported lifecycle state source'))
  })
})
