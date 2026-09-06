import type { ArkChatMediaFileSpec } from './media-file-types.js'

/** Existing loopback-only RPC channel; v3 adds durable, multi-file draft bundles. */
export const NATIVE_MEDIA_RPC_CHANNEL = '/volcengine-media'
export const NATIVE_MEDIA_PROTOCOL_VERSION = 3
export const NATIVE_MEDIA_RECOMMENDED_CHUNK_BYTES = 1024 * 1024

export interface NativeMediaFileDeclaration extends ArkChatMediaFileSpec {
  readonly name: string
  readonly bytes: number
}

export interface NativeMediaBundleSummary {
  readonly bundleId: string
  readonly label: string
  readonly state: 'ready' | 'claimed'
  readonly expectedProvider: string
  readonly expectedModel: string
}

export interface NativeMediaCapabilities {
  readonly version: typeof NATIVE_MEDIA_PROTOCOL_VERSION
  readonly chunkBytes: number
  readonly nativeDrafts: true
}

