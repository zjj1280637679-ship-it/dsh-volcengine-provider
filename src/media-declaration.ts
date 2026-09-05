/** A grammar or attachment declaration the user can correct without resending bytes. */
export class MediaCommandInputError extends Error {}

/** Explicit per-attachment media choice shared by commands and future UI controls. */
export interface MediaDeclaration {
  readonly mediaType: string
  readonly format?: string
}

export interface ResolvedMediaDeclaration extends MediaDeclaration {
  readonly modality: 'image' | 'video' | 'audio'
}

export function resolveMediaDeclaration(value: MediaDeclaration): ResolvedMediaDeclaration {
  const match = /^(image|video|audio)\/([a-z0-9!#$%&'*+.^_`|~-]+)$/iu.exec(value.mediaType.trim())
  if (match === null || match[2] === '*') {
    throw new MediaCommandInputError(`Invalid media declaration: ${value.mediaType}. Use an explicit image, video, or audio MIME type.`)
  }
  const modality = match[1]!.toLowerCase() as ResolvedMediaDeclaration['modality']
  const mediaType = `${modality}/${match[2]!.toLowerCase()}`
  if (value.format !== undefined && modality !== 'audio') {
    throw new MediaCommandInputError('A format override is available only for audio, for example audio/x-custom=vendorformat.')
  }
  if (value.format !== undefined && !/^[a-z0-9!#$%&'*+.^_`|~-]+$/iu.test(value.format)) {
    throw new MediaCommandInputError('Invalid media declaration: the audio format override must be a non-empty token.')
  }
  return { modality, mediaType, ...(value.format === undefined ? {} : { format: value.format }) }
}

