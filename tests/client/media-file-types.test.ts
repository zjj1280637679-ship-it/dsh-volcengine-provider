import { describe, expect, it } from 'vitest'

import {
  ARK_CHAT_MEDIA_ACCEPT,
  arkChatMediaFileSpec,
  isArkChatMediaDeclaration,
} from '../../src/media-file-types.js'

describe('Ark Chat media file vocabulary', () => {
  it.each([
    ['still.JPEG', 'image/jpeg', { modality: 'image', mediaType: 'image/jpeg' }],
    ['scan.heif', 'image/heif', { modality: 'image', mediaType: 'image/heic' }],
    ['clip.MOV', 'video/quicktime', { modality: 'video', mediaType: 'video/quicktime' }],
    ['voice.m4a', 'audio/mp4', { modality: 'audio', mediaType: 'audio/x-m4a', format: 'm4a' }],
    ['voice.wav', '', { modality: 'audio', mediaType: 'audio/wav', format: 'wav' }],
  ])('maps %s without changing its bytes', (name, browserType, expected) => {
    expect(arkChatMediaFileSpec(name, browserType)).toEqual(expected)
    expect(isArkChatMediaDeclaration(expected)).toBe(true)
  })

  it('refuses unknown formats and contradictory browser declarations', () => {
    expect(() => arkChatMediaFileSpec('paper.pdf', 'application/pdf')).toThrow(/does not document/u)
    expect(() => arkChatMediaFileSpec('clip.mp4', 'audio/mpeg')).toThrow(/disagree/u)
    expect(() => arkChatMediaFileSpec('clip.mp4', 'application/x-made-up')).toThrow(/unsupported media type/u)
  })

  it('advertises Chat image, video, and audio while excluding Responses-only PDF', () => {
    expect(ARK_CHAT_MEDIA_ACCEPT).toContain('.mp4')
    expect(ARK_CHAT_MEDIA_ACCEPT).toContain('.mov')
    expect(ARK_CHAT_MEDIA_ACCEPT).toContain('.png')
    expect(ARK_CHAT_MEDIA_ACCEPT).toContain('.m4a')
    expect(ARK_CHAT_MEDIA_ACCEPT).not.toContain('.pdf')
  })
})
