export const MODALITIES = ['text', 'image', 'video', 'audio'] as const
export const DEFAULT_AGENT_MEDIA_FALLBACK_MB = 45

export type Modality = (typeof MODALITIES)[number]
export type CapabilityReport = 'supported' | 'unsupported' | 'unknown'
export type ModalityOverride = 'inherit' | 'force_enable' | 'force_disable'

export interface ModalityFeedback {
  reportedSupport: CapabilityReport
  source?: string
  raw?: unknown
}

export interface ModelFeedback {
  modalities?: Partial<Record<Modality, ModalityFeedback>>
  status?: string
  raw: Record<string, unknown>
  fetchedAt?: string
}

export interface ModalityConfig {
  /** Undefined means unknown: it neither asserts support nor blocks an attempt. */
  override?: ModalityOverride
}

export interface ModelConfig {
  modalities: Partial<Record<Modality, ModalityConfig>>
  /** Decimal megabytes; zero disables tool-result media omission. */
  agentMediaFallbackMB: number
  customBody?: Record<string, unknown>
}

export interface RuntimeObservation {
  timestamp: string
  route: string
  model: string
  modality?: Modality
  ok: boolean
  statusCode?: number
  detail?: string
}

export interface ModelEntry {
  id: string
  feedback?: ModelFeedback
  config: ModelConfig
  observations: RuntimeObservation[]
}

export function createDefaultModelConfig(): ModelConfig {
  return { modalities: {}, agentMediaFallbackMB: DEFAULT_AGENT_MEDIA_FALLBACK_MB }
}

/**
 * Deliberately does not accept ModelFeedback.
 *
 * Supplier feedback is evidence, not permission. Effective modality permission
 * is derived only from explicit local configuration.
 */
export function isModalityEnabled(
  config: ModelConfig,
  modality: Modality,
): boolean {
  const setting = config.modalities[modality]

  if (setting?.override === 'force_enable') return true
  if (setting?.override === 'force_disable') return false
  // Unknown is permissive for dispatch only. It is not a capability claim.
  return true
}
