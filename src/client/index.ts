import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings-models/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { VolcengineCard } from './Card.js'
import { VolcenginePluginSettingsCard } from './PluginSettingsCard.js'
import { createCardOperations } from './operations.js'
import { registerMediaDock } from './media-registration.js'

// Both supported generations share Slots. The settings transport is selected
// lazily after the injected client packages have completed activation.
export const inject = ['slots']

/** One namespace registration serves all present and future route cards. */
export function apply(ctx: Context): void {
  registerMediaDock(ctx)
  const operations = createCardOperations(ctx)
  // provider-card is an rc.1+/alpha extension and is intentionally absent
  // from the rc.2 SlotMap. Use a structural view for cross-version compilation.
  const modelSlots = ctx.slots as unknown as {
    inject(name: string, register: () => () => void): void
    register(
      options: {
        name: string
        key: string
        inject: () => { operations: typeof operations }
      },
      component: typeof VolcengineCard,
    ): () => void
  }
  let modelSeat = false
  let pluginSeat = false
  let modelRegistration: (() => void) | undefined
  let pluginRegistration: (() => void) | undefined
  const disposeModel = (): void => { modelRegistration?.(); modelRegistration = undefined }
  const disposePlugin = (): void => { pluginRegistration?.(); pluginRegistration = undefined }
  const reconcile = (): void => {
    if (modelSeat) {
      disposePlugin()
      modelRegistration ??= modelSlots.register({
        name: 'settings.models.provider-card',
        key: 'llm-volcengine',
        inject: () => ({ operations }),
      }, VolcengineCard)
      return
    }
    disposeModel()
    if (pluginSeat) {
      pluginRegistration ??= ctx.slots.register({
        name: 'settings.plugin.item',
        key: 'llm-volcengine',
        inject: () => ({ operations }),
      }, VolcenginePluginSettingsCard)
    } else disposePlugin()
  }

  modelSlots.inject('settings.models.provider-card', () => {
    modelSeat = true
    reconcile()
    return () => { modelSeat = false; disposeModel(); reconcile() }
  })
  ctx.slots.inject('settings.plugin.item', () => {
    pluginSeat = true
    reconcile()
    return () => { pluginSeat = false; disposePlugin(); reconcile() }
  })
}
