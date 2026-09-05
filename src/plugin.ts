import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { attributionHeaders, LlmError, normalizeApiKey, type AdapterRegistrationHandle, type DirectoryRegistrationHandle } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-attachment'

import { Config, SETTINGS_NS, providerId, resolveConfig, type ResolvedConfig } from './config.js'
import { ConfiguredVolcengineAdapter } from './configured-adapter.js'
import { discoverModels } from './chat/discovery.js'
import type { ResolveMediaBytes } from './chat/serialize.js'
import type { VerbatimAttachmentRefLike } from './media.js'
import { registerMediaCommand } from './media-command.js'

export { Config } from './config.js'
export const name = SETTINGS_NS
export const inject = ['llm']

/** Newer attachment providers expose this verbatim stream in addition to readImage. */
interface VerbatimFileReader {
  readFileStream(ref: VerbatimAttachmentRefLike, signal?: AbortSignal): AsyncIterable<Uint8Array>
}

function mediaResolver(ctx: Context): ResolveMediaBytes {
  return async (block, signal) => {
    const attachments = ctx.get('attachments')
    if (attachments === undefined) throw new LlmError('Mount a Harness attachment provider to read media.', 'MEDIA_RESOLVER_UNAVAILABLE')
    if (block.type === 'image') return (await attachments.readImage(block.attachment, signal)).data
    const files = attachments as typeof attachments & Partial<VerbatimFileReader>
    if (typeof files.readFileStream !== 'function') {
      throw new LlmError('This Harness attachment provider cannot read original media files.', 'MEDIA_RESOLVER_UNAVAILABLE')
    }
    const chunks: Uint8Array[] = []
    for await (const chunk of files.readFileStream(block.attachment, signal)) {
      signal?.throwIfAborted()
      chunks.push(chunk)
    }
    return Buffer.concat(chunks)
  }
}

/** Register the three configurable routes using the host's settings and credential seams. */
export function apply(ctx: Context, config: Config = {}): void {
  const entry = resolveConfig(config)
  let source: () => Config = () => entry
  let active = entry
  const routeFor = (provider: string) => {
    const key = Object.keys(active.routes).find(key => providerId(key) === provider)
    if (key === undefined) throw new LlmError(`Unknown Volcengine provider route: ${provider}`, 'UNKNOWN_PROVIDER')
    return active.routes[key]!
  }

  const resolveKey = async (reference: string): Promise<string> => {
    const credentials = ctx.get('credentials')
    const raw = credentials === undefined
      ? launchEnvironmentOf(ctx).get(reference)?.value
      : (await credentials.resolve(credentialRef(reference)))?.value
    if (raw === undefined) throw new LlmError(`Set ${reference} in the provider card or launch environment.`, 'MISSING_CREDENTIAL')
    const checked = normalizeApiKey(raw)
    if (!checked.ok) throw new LlmError(`The credential referenced by ${reference} is empty or malformed.`, 'INVALID_API_KEY')
    return checked.value
  }

  const adapter = new ConfiguredVolcengineAdapter({ route: routeFor, resolveKey, resolveMediaBytes: mediaResolver(ctx) })
  let registered: AdapterRegistrationHandle | undefined
  let directory: DirectoryRegistrationHandle | undefined
  let ownedProviders = new Set<string>()
  let ownedDirectory = new Set<string>()
  registerMediaCommand(ctx, provider => ownedProviders.has(provider))
  const entriesFor = (value: ResolvedConfig) => Object.entries(value.routes).map(([key, route]) => ({
    provider: providerId(key), displayName: route.name, settingsNs: SETTINGS_NS,
    settingsPath: ['routes', key],
  }))
  const validate = (value: Config): ResolvedConfig => {
    const next = resolveConfig(value)
    const live = new Set(ctx.llm.listProviders().map(route => route.id))
    const declared = new Set(ctx.llm.listConfigurableProviders().map(route => route.provider))
    for (const [key, route] of Object.entries(next.routes)) {
      const provider = providerId(key)
      if (declared.has(provider) && !ownedDirectory.has(provider)
        || route.enabled && live.has(provider) && !ownedProviders.has(provider)) {
        throw new LlmError(`Another plugin already owns provider route ${provider}.`, 'DUPLICATE_ADAPTER')
      }
    }
    return next
  }
  const sync = (): void => {
    const next = validate(source())
    const previous = active
    const previousDirectory = directory
    const entries = entriesFor(next)
    const enabled = Object.entries(next.routes).filter(([, route]) => route.enabled).map(([key]) => providerId(key))
    // Registration reads providerInfo synchronously, so expose the candidate
    // for that call and restore both observations if a registration rejects it.
    active = next
    try {
      if (directory !== undefined) directory.replace(entries)
      else if (entries.length > 0) directory = ctx.llm.registerConfigurableProviders(entries)
      if (registered !== undefined) registered.replace(enabled)
      else if (enabled.length > 0) registered = ctx.llm.registerAdapter(enabled, adapter)
      ownedDirectory = new Set(entries.map(route => route.provider))
      ownedProviders = new Set(enabled)
    } catch (error) {
      active = previous
      if (previousDirectory !== undefined) previousDirectory.replace(entriesFor(previous))
      else { directory?.(); directory = undefined }
      throw error
    }
  }
  sync()

  ctx.llm.registerModelDiscovery(SETTINGS_NS, async (draft, signal) => {
    if (draft.provider === undefined) throw new LlmError('Select a Volcengine route before refreshing its model feedback.', 'INVALID_REQUEST')
    const route = routeFor(draft.provider)
    const apiKey = draft.apiKey === undefined ? await resolveKey(route.apiKeyEnv) : draft.apiKey
    const models = await discoverModels({
      provider: draft.provider,
      route: { kind: route.kind, baseUrl: draft.baseURL ?? route.baseURL, apiKeyEnv: route.apiKeyEnv },
      apiKey, signal, feedback: adapter.feedback, headers: attributionHeaders(),
    })
    // Discovery is advisory. Configuration writes belong to the settings UI.
    return models.map(model => ({ id: model.id, name: model.name }))
  })

  ctx.inject(['settings'], settingsCtx => {
    settingsCtx.settings.installSection(ctx, SETTINGS_NS, Config, entry, {
      setSource: current => { source = current },
      onChange: sync,
      validate: value => { validate(value) },
    })
  })
}
