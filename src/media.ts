import { createHash } from 'node:crypto'

import type {} from '@deepseek-ai/dsh-llm'

/**
 * Structural subset of DSH FileAttachmentRef. DSH verbatim file references are
 * assignable to this type without making the low-level media helpers depend on
 * the attachment package at runtime.
 */
export interface VerbatimAttachmentRefLike {
  readonly attachmentId: string
  readonly name: string
  readonly bytes: number
}

/** Original image stored through the host's generic file admission path. */
export interface VolcengineImageBlock {
  type: 'volcengine-image'
  attachment: VerbatimAttachmentRefLike
  mediaType: string
}

/** Namespaced plugin block to avoid colliding with a future DSH core video block. */
export interface VolcengineVideoBlock {
  type: 'volcengine-video'
  attachment: VerbatimAttachmentRefLike
  mediaType: string
}

/** Namespaced plugin block to avoid colliding with a future DSH core audio block. */
export interface VolcengineAudioBlock {
  type: 'volcengine-audio'
  attachment: VerbatimAttachmentRefLike
  mediaType: string
  /** Wire format declaration only; never requests a local audio conversion. */
  format?: string
}

declare module '@deepseek-ai/dsh-llm' {
  interface ContentBlockMap {
    'volcengine-image': VolcengineImageBlock
    'volcengine-video': VolcengineVideoBlock
    'volcengine-audio': VolcengineAudioBlock
  }

  interface ModelModalityMap {
    video: 'video'
    audio: 'audio'
  }
}

/** MIME aliases are spelling conveniences, not a list of permitted formats. */
export function audioFormatOf(block: VolcengineAudioBlock): string {
  if (block.format !== undefined) {
    if (block.format.trim() === '') throw new Error('Audio format must not be blank.')
    return block.format
  }
  const mediaType = block.mediaType.split(';', 1)[0]!.trim().toLowerCase()
  const aliases: Record<string, string> = {
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/wav': 'wav',
    'audio/wave': 'wav',
    'audio/x-wav': 'wav',
    'audio/vnd.wave': 'wav',
    'audio/aac': 'aac',
    'audio/m4a': 'm4a',
    'audio/x-m4a': 'm4a',
    'audio/mp4': 'm4a',
  }
  if (Object.hasOwn(aliases, mediaType)) return aliases[mediaType]!
  const subtype = /^audio\/([^\s/;]+)$/u.exec(mediaType)?.[1]
  if (subtype !== undefined) return subtype
  throw new Error('Declare an audio MIME type or an explicit audio format.')
}

export interface ParsedDataUrl {
  mediaType: string
  data: Uint8Array
}

/** Transparent encoding only: raw bytes become base64 without media transformation. */
export function encodeVerbatimBase64(data: Uint8Array): string {
  return Buffer.from(data).toString('base64')
}

export function decodeVerbatimBase64(data: string): Uint8Array {
  return Uint8Array.from(Buffer.from(data, 'base64'))
}

/** Build a base64 data URL while preserving the exact underlying bytes. */
export function toVerbatimDataUrl(mediaType: string, data: Uint8Array): string {
  return `data:${mediaType};base64,${encodeVerbatimBase64(data)}`
}

/** Parse only the transparent base64 data-URL form emitted by this module. */
export function parseVerbatimDataUrl(url: string): ParsedDataUrl {
  const match = /^data:([^;,]+);base64,(.*)$/su.exec(url)
  if (match === null) throw new Error('Expected a base64 data URL.')
  return {
    mediaType: match[1] as string,
    data: decodeVerbatimBase64(match[2] as string),
  }
}

export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}
