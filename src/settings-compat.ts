import type { Context } from '@deepseek-ai/cordis'
import type z from '@deepseek-ai/schemastery'

/** Hooks shared by the two published Harness settings attachment shapes. */
export interface SettingsSectionHooks<T> {
  setSource(current: () => T): void
  onChange(): void
  validate?(value: T): void
}

interface SettingsScopeLike<T> {
  get(): T
  watch(callback: (next: T, previous: T) => void | Promise<void>): () => void
}

interface SettingsProviderLike {
  register<T>(ns: string, schema: z<T>, options?: { base?: Partial<T>; validate?: (value: T) => void }): SettingsScopeLike<T>
  installSection?<T>(owner: Context, ns: string, schema: z<T>, entry: T, hooks: SettingsSectionHooks<T>): void
}

type SettingsContextLike = Omit<Context, 'settings'> & { settings: SettingsProviderLike }

// Cordis publishes FiberState as a const enum, so no runtime enum object exists
// for plugins to import. These are the stable DISPOSED/UNLOADING values used by
// both supported Harness generations.
const FIBER_DISPOSED = 4
const FIBER_UNLOADING = 5

function ownerIsUnloading(owner: Context): boolean {
  const state = owner.fiber.state as number
  return state === FIBER_DISPOSED || state === FIBER_UNLOADING
}

/**
 * Attach a settings section across the 0.1.1 and 0.1.2+ public contracts.
 *
 * Harness 0.1.1 exposes the canonical wiring as the standalone
 * `installSettingsSection()` helper, while 0.1.2 moved it onto the provider as
 * `installSection()`. Reproducing the older helper through the shared public
 * register/watch/effect seams avoids importing a named export that newer hosts
 * intentionally no longer publish.
 */
export function installCompatibleSettingsSection<T>(
  owner: Context,
  settingsCtx: SettingsContextLike,
  ns: string,
  schema: z<T>,
  entry: T,
  hooks: SettingsSectionHooks<T>,
): void {
  const settings = settingsCtx.settings
  if (typeof settings.installSection === 'function') {
    settings.installSection(owner, ns, schema, entry, hooks)
    return
  }

  const scope = settings.register(ns, schema, {
    base: entry,
    ...(hooks.validate === undefined ? {} : { validate: hooks.validate }),
  })
  hooks.setSource(() => scope.get())
  settingsCtx.effect(() => () => {
    if (ownerIsUnloading(owner)) return
    hooks.setSource(() => entry)
    hooks.onChange()
  })
  hooks.onChange()
  scope.watch(() => {
    if (ownerIsUnloading(owner)) return
    hooks.onChange()
  })
}
