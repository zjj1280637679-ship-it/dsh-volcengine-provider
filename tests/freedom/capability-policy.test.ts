import { describe, expect, it } from 'vitest'

import {
  createDefaultModelConfig,
  isModalityEnabled,
  type ModelFeedback,
} from '../../src/domain.js'
import { modelPolicy } from '../../src/config.js'

describe('freedom contract: modality policy', () => {
  it('allows a modality to be force-enabled even when supplier feedback says unsupported', () => {
    const feedback: ModelFeedback = {
      modalities: {
        video: {
          reportedSupport: 'unsupported',
          source: 'volcengine',
        },
      },
      raw: { supports_video: false },
    }

    const config = createDefaultModelConfig()
    config.modalities.video = { override: 'force_enable' }

    // Feedback is intentionally not an input to the permission function.
    expect(feedback.modalities?.video?.reportedSupport).toBe('unsupported')
    expect(isModalityEnabled(config, 'video')).toBe(true)
  })

  it('lets explicit force-disable win over the default enabled state', () => {
    const config = createDefaultModelConfig()
    config.modalities.text = { override: 'force_disable' }

    expect(isModalityEnabled(config, 'text')).toBe(false)
  })

  it.each(['image', 'video', 'audio'] as const)(
    'leaves unconfigured %s unknown and permits a user-requested attempt', modality => {
      const config = createDefaultModelConfig()

      expect(Object.hasOwn(config.modalities, modality)).toBe(false)
      expect(isModalityEnabled(config, modality)).toBe(true)
    },
  )

  it('does not generate media settings for a manually entered model id', () => {
    const config = modelPolicy({ id: 'user-entered-model' })

    expect(config.modalities).toEqual({})
    expect(config.agentMediaFallbackMB).toBe(45)
    expect(['image', 'video', 'audio'].every(modality =>
      !Object.hasOwn(config.modalities, modality))).toBe(true)
  })

  it('keeps the user-owned agent media fallback budget, including explicit disable', () => {
    expect(modelPolicy({ id: 'default' }).agentMediaFallbackMB).toBe(45)
    expect(modelPolicy({ id: 'disabled', agentMediaFallbackMB: 0 }).agentMediaFallbackMB).toBe(0)
    expect(modelPolicy({ id: 'custom', agentMediaFallbackMB: 12.5 }).agentMediaFallbackMB).toBe(12.5)
  })

  it('treats an explicit inherit as unknown without consulting supplier feedback', () => {
    const config = createDefaultModelConfig()
    config.modalities.audio = { override: 'inherit' }

    expect(isModalityEnabled(config, 'audio')).toBe(true)
  })
})
