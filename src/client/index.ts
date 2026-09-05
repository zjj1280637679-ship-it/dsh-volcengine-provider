import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings-models/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { VolcengineCard } from './Card.js'
import { createCardOperations } from './operations.js'
import { registerMediaDock } from './media-registration.js'

// Older published Harness clients expose the assembled Remote as one service;
// newer clients additionally publish per-namespace dependency names. The card
// calls namespace methods lazily, so requiring the common assembled service is
// sufficient and prevents a compatible older host from leaving this plugin in
// a permanent pending state.
export const inject = ['slots', 'remote']

/** One namespace registration serves all present and future route cards. */
export function apply(ctx: Context): void {
  registerMediaDock(ctx)
  const operations = createCardOperations(ctx)
  ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register({
    name: 'settings.models.provider-card',
    key: 'llm-volcengine',
    inject: () => ({ operations }),
  }, VolcengineCard))
}
