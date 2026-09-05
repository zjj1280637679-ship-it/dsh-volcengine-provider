import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings-models/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { VolcengineCard } from './Card.js'
import { createCardOperations } from './operations.js'

export const inject = ['slots', 'remote', 'remote.settings', 'remote.credentials']

/** One namespace registration serves all present and future route cards. */
export function apply(ctx: Context): void {
  const operations = createCardOperations(ctx)
  ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register({
    name: 'settings.models.provider-card',
    key: 'llm-volcengine',
    inject: () => ({ operations }),
  }, VolcengineCard))
}
