export const MODALITIES = ['text', 'image', 'video', 'audio'] as const

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
  enabled: boolean
  override: ModalityOverride
}

export interface ModelConfig {
  modalities: Record<Modality, ModalityConfig>
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
  return {
    modalities: {
      text: { enabled: true, override: 'inherit' },
      image: { enabled: false, override: 'inherit' },
      video: { enabled: false, override: 'inherit' },
      audio: { enabled: false, override: 'inherit' },
    },
  }
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

  if (setting.override === 'force_enable') return true
  if (setting.override === 'force_disable') return false
  return setting.enabled
}
