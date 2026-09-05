import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import {
  attributionHeaders,
  LlmError,
  normalizeApiKey,
  type AdapterRegistrationHandle,
  type DirectoryRegistrationHandle,
  type LlmModelDiscoveryRequest,
} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-attachment'

import { Config, SETTINGS_NS, providerId, resolveConfig, type ResolvedConfig } from './config.js'
import { ConfiguredVolcengineAdapter } from './configured-adapter.js'
import { discoverModels } from './chat/discovery.js'
import type { ResolveMediaBytes } from './chat/serialize.js'
import type { VerbatimAttachmentRefLike } from './media.js'
import { OriginalVideoStaging, registerMediaFallbackRpc } from './media-fallback-rpc.js'
import { registerLocalMediaCommand, registerMediaCommand } from './media-command.js'
import { createOriginalMediaStore, type OriginalMediaStore } from './original-media-store.js'
import { installCompatibleSettingsSection } from './settings-compat.js'
import { inspectLlmHost } from './host-compat.js'

export { Config } from './config.js'
export const name = SETTINGS_NS
export const inject = ['llm']

/** Newer attachment providers expose this verbatim stream in addition to readImage. */
interface VerbatimFileReader {
  readFileStream(ref: VerbatimAttachmentRefLike, signal?: AbortSignal): AsyncIterable<Uint8Array>
}

function expectedMediaBytes(ref: VerbatimAttachmentRefLike): number {
  if (!Number.isSafeInteger(ref.bytes) || ref.bytes < 0) {
    throw new LlmError('The attachment byte length is invalid.', 'INVALID_MEDIA_REFERENCE')
  }
  return ref.bytes
}

async function readVerbatimBytes(
  files: VerbatimFileReader,
  ref: VerbatimAttachmentRefLike,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const expected = expectedMediaBytes(ref)
  let data: Buffer
  try {
    // The host reference already carries the admitted byte length. Allocate
    // once and fill it directly instead of retaining every stream chunk and
    // copying them again through Buffer.concat().
    data = Buffer.allocUnsafe(expected)
  } catch (cause) {
    throw new LlmError(
      'The attachment cannot be represented in this Node.js process.',
      'MEDIA_SIZE_UNREPRESENTABLE',
      { cause },
    )
  }

  let offset = 0
  for await (const chunk of files.readFileStream(ref, signal)) {
    signal?.throwIfAborted()
    if (offset + chunk.byteLength > expected) {
      throw new LlmError('The attachment stream exceeded its declared byte length.', 'MEDIA_SIZE_MISMATCH')
    }
    data.set(chunk, offset)
    offset += chunk.byteLength
  }
  signal?.throwIfAborted()
  if (offset !== expected) {
    throw new LlmError('The attachment stream ended before its declared byte length.', 'MEDIA_SIZE_MISMATCH')
  }
  return data
}

function mediaResolver(ctx: Context, originals: OriginalMediaStore): ResolveMediaBytes {
  return async (block, signal) => {
    if (originals.owns(block.attachment)) {
      if (block.type !== 'volcengine-video' || block.mediaType !== 'video/mp4') {
        throw new LlmError('The plugin-owned original media reference does not match an MP4 video block.', 'INVALID_MEDIA_REFERENCE')
      }
      return originals.read(block.attachment, signal)
    }
    const attachments = ctx.get('attachments')
    if (attachments === undefined) throw new LlmError('Mount a Harness attachment provider to read media.', 'MEDIA_RESOLVER_UNAVAILABLE')
    if (block.type === 'image') return (await attachments.readImage(block.attachment, signal)).data
    const files = attachments as typeof attachments & Partial<VerbatimFileReader>
    if (typeof files.readFileStream !== 'function') {
      throw new LlmError('This Harness attachment provider cannot read original media files.', 'MEDIA_RESOLVER_UNAVAILABLE')
    }
    return readVerbatimBytes(files as VerbatimFileReader, block.attachment, signal)
  }
}

/** rc.2 carries cancellation in the request; later hosts pass it beside the request. */
export function modelDiscoverySignal(
  request: LlmModelDiscoveryRequest,
  legacySignal?: AbortSignal,
): AbortSignal | undefined {
  return legacySignal ?? (request as LlmModelDiscoveryRequest & { signal?: AbortSignal }).signal
}

/** Register the three configurable routes using the host's settings and credential seams. */
export function apply(ctx: Context, config: Config = {}): void {
  const capabilities = inspectLlmHost(ctx.get('llm'))
  if (!capabilities.core) {
    const missing = capabilities.missing.filter(name => name === 'registerAdapter' || name === 'listProviders')
    ctx.logger.warn(
      'dsh-volcengine-provider: disabled because the Host LLM service lacks public capabilities: %s',
      missing.join(', '),
    )
    return
  }
  if (!capabilities.directory) {
    ctx.logger.warn(
      'dsh-volcengine-provider: Host provider-directory capabilities are unavailable; statically configured routes remain usable',
    )
  }
  if (!capabilities.discovery) {
    ctx.logger.warn(
      'dsh-volcengine-provider: Host model-discovery registration is unavailable; manual model configuration remains usable',
    )
  }

  const entry = resolveConfig(config)
  let source: () => Config = () => entry
  let active = entry
  const routeFor = (provider: string) => {
    const key = Object.keys(active.routes).find(key => providerId(key) === provider)
    if (key === undefined) throw new LlmError(`Unknown Volcengine provider route: ${provider}`, 'UNKNOWN_PROVIDER')
    return active.routes[key]!
  }

  const resolveKey = async (reference: string): Promise<string> => {
    const credentials = ctx.get('credentials') as { resolve?: (ref: ReturnType<typeof credentialRef>) => Promise<{ value: string } | undefined> } | undefined
    const raw = typeof credentials?.resolve !== 'function'
      ? launchEnvironmentOf(ctx).get(reference)?.value
      : (await credentials.resolve(credentialRef(reference)))?.value
    if (raw === undefined) throw new LlmError(`Set ${reference} in the provider card or launch environment.`, 'MISSING_CREDENTIAL')
    const checked = normalizeApiKey(raw)
    if (!checked.ok) throw new LlmError(`The credential referenced by ${reference} is empty or malformed.`, 'INVALID_API_KEY')
    return checked.value
  }

  const originals = createOriginalMediaStore(ctx)
  const staging = new OriginalVideoStaging(originals)
  const adapter = new ConfiguredVolcengineAdapter({ route: routeFor, resolveKey, resolveMediaBytes: mediaResolver(ctx, originals) })
  let registered: AdapterRegistrationHandle | undefined
  let directory: DirectoryRegistrationHandle | undefined
  let ownedProviders = new Set<string>()
  let ownedDirectory = new Set<string>()
  registerMediaFallbackRpc(ctx, staging)
  registerMediaCommand(ctx, provider => ownedProviders.has(provider))
  registerLocalMediaCommand(ctx, provider => ownedProviders.has(provider), staging)
  const entriesFor = (value: ResolvedConfig) => Object.entries(value.routes).map(([key, route]) => ({
    provider: providerId(key), displayName: route.name, settingsNs: SETTINGS_NS,
    settingsPath: ['routes', key],
  }))
  const validate = (value: Config): ResolvedConfig => {
    const next = resolveConfig(value)
    const live = new Set(ctx.llm.listProviders().map(route => route.id))
    const declared = capabilities.directory
      ? new Set(ctx.llm.listConfigurableProviders().map(route => route.provider))
      : new Set<string>()
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
      if (capabilities.directory) {
        if (directory !== undefined) directory.replace(entries)
        else if (entries.length > 0) directory = ctx.llm.registerConfigurableProviders(entries)
      }
      if (registered !== undefined) registered.replace(enabled)
      else if (enabled.length > 0) registered = ctx.llm.registerAdapter(enabled, adapter)
      ownedDirectory = capabilities.directory
        ? new Set(entries.map(route => route.provider))
        : new Set()
      ownedProviders = new Set(enabled)
    } catch (error) {
      active = previous
      if (previousDirectory !== undefined) previousDirectory.replace(entriesFor(previous))
      else { directory?.(); directory = undefined }
      throw error
    }
  }
  sync()

  if (capabilities.discovery) {
    ctx.llm.registerModelDiscovery(SETTINGS_NS, async (
      draft: LlmModelDiscoveryRequest,
      legacySignal?: AbortSignal,
    ) => {
      const signal = modelDiscoverySignal(draft, legacySignal)
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
  }

  ctx.inject(['settings'], settingsCtx => {
    const installed = installCompatibleSettingsSection(ctx, settingsCtx, SETTINGS_NS, Config, entry, {
      setSource: current => { source = current },
      onChange: sync,
      validate: value => { validate(value) },
    })
    if (!installed) {
      ctx.logger.warn(
        'dsh-volcengine-provider: Host settings attachment capabilities are unavailable; static profile configuration remains active',
      )
    }
  })
}
