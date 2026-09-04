import { describe, expect, it } from 'vitest'

import {
  createDefaultModelConfig,
  isModalityEnabled,
  type ModelFeedback,
} from '../../src/domain.js'

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
    config.modalities.video.override = 'force_enable'

    // Feedback is intentionally not an input to the permission function.
    expect(feedback.modalities?.video?.reportedSupport).toBe('unsupported')
    expect(isModalityEnabled(config, 'video')).toBe(true)
  })

  it('lets explicit force-disable win over the default enabled state', () => {
    const config = createDefaultModelConfig()
    config.modalities.text.override = 'force_disable'

    expect(isModalityEnabled(config, 'text')).toBe(false)
  })

  it('uses local configured state for inherit without consulting supplier feedback', () => {
    const config = createDefaultModelConfig()
    config.modalities.audio.enabled = true
    config.modalities.audio.override = 'inherit'

    expect(isModalityEnabled(config, 'audio')).toBe(true)
  })
})
