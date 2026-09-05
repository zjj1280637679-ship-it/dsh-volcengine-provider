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
  register?<T>(ns: string, schema: z<T>, options?: { base?: Partial<T>; validate?: (value: T) => void }): SettingsScopeLike<T>
  installSection?<T>(owner: Context, ns: string, schema: z<T>, entry: T, hooks: SettingsSectionHooks<T>): void
}

type SettingsContextLike = Omit<Context, 'settings'> & { settings: SettingsProviderLike }

export type SettingsSectionMode = 'install-section' | 'register-watch' | 'unavailable'

/** Select a settings attachment seam structurally, without consulting a Host version. */
export function settingsSectionMode(value: unknown): SettingsSectionMode {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return 'unavailable'
  const settings = value as SettingsProviderLike
  if (typeof settings.installSection === 'function') return 'install-section'
  if (typeof settings.register === 'function') return 'register-watch'
  return 'unavailable'
}

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
): boolean {
  const settings = settingsCtx.settings
  const mode = settingsSectionMode(settings)
  if (mode === 'install-section') {
    settings.installSection!(owner, ns, schema, entry, hooks)
    return true
  }
  if (mode === 'unavailable') return false

  const scope = settings.register!(ns, schema, {
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
  return true
}
