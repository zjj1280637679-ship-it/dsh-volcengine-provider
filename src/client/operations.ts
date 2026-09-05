import type { Context } from '@deepseek-ai/cordis'
import type {
  CredentialInfo, SettingsDescribeValue, SettingsNamespaceView, SettingsPathOpView,
} from '@deepseek-ai/dsh-api-remotes/client'

export interface CardOperations {
  read(): Promise<SettingsDescribeValue>
  describeCredential(ref: string): Promise<CredentialInfo | undefined>
  saveSettings(ns: string, ops: SettingsPathOpView[], revision: number): Promise<SettingsNamespaceView>
  saveCredential(ref: string, value: string): Promise<void>
}

/** Bind official Remote calls once; the React component receives plain callbacks. */
export function createCardOperations(ctx: Context): CardOperations {
  return {
    async read() {
      const result = await ctx.remote.settings.describe()
      if (!result.ok) throw new Error(result.error.message)
      return result.value
    },
    async describeCredential(ref) {
      const result = await ctx.remote.credentials.describe([ref])
      if (!result.ok) throw new Error(result.error.message)
      return result.value[ref]
    },
    async saveSettings(ns, ops, revision) {
      const result = await ctx.remote.settings.mutate(ns, ops, revision)
      if (!result.ok) {
        throw new Error(result.error.code === 'settings/conflict'
          ? '配置已在其他位置更新。请重新载入后再保存。'
          : result.error.message)
      }
      return result.value
    },
    async saveCredential(ref, value) {
      const result = await ctx.remote.credentials.set(ref, value)
      if (!result.ok) throw new Error('密钥未保存，请保留当前页面并重试。')
    },
  }
}
