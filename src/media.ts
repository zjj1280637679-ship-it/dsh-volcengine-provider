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
}

declare module '@deepseek-ai/dsh-llm' {
  interface ContentBlockMap {
    'volcengine-video': VolcengineVideoBlock
    'volcengine-audio': VolcengineAudioBlock
  }

  interface ModelModalityMap {
    video: 'video'
    audio: 'audio'
  }
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
