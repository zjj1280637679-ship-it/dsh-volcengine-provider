export type ArkChatMediaModality = 'image' | 'video' | 'audio'

export interface ArkChatMediaFileSpec {
  readonly modality: ArkChatMediaModality
  readonly mediaType: string
  /** Ark Chat's input_audio format. Images and videos never carry this field. */
  readonly format?: 'mp3' | 'wav' | 'aac' | 'm4a'
}

interface RegisteredFormat extends ArkChatMediaFileSpec {
  readonly extensions: readonly string[]
  readonly browserAliases?: readonly string[]
}

/**
 * Ark Chat's documented raw-media vocabulary. Keep this table shared by the
 * browser picker and the Host validator so an upgrade cannot make the two
 * sides disagree. PDF deliberately stays out: Ark accepts it through the
 * Responses/Files path, which this Chat adapter does not pretend to provide.
 */
const FORMATS: readonly RegisteredFormat[] = [
  { modality: 'image', mediaType: 'image/jpeg', extensions: ['jpg', 'jpeg'], browserAliases: ['image/jpg'] },
  { modality: 'image', mediaType: 'image/png', extensions: ['png'] },
  { modality: 'image', mediaType: 'image/gif', extensions: ['gif'] },
  { modality: 'image', mediaType: 'image/webp', extensions: ['webp'] },
  { modality: 'image', mediaType: 'image/bmp', extensions: ['bmp', 'dib'], browserAliases: ['image/x-bmp'] },
  { modality: 'image', mediaType: 'image/tiff', extensions: ['tif', 'tiff'] },
  { modality: 'image', mediaType: 'image/x-icon', extensions: ['ico'], browserAliases: ['image/vnd.microsoft.icon'] },
  { modality: 'image', mediaType: 'image/x-icns', extensions: ['icns'] },
  { modality: 'image', mediaType: 'image/sgi', extensions: ['sgi'] },
  { modality: 'image', mediaType: 'image/jp2', extensions: ['j2c', 'j2k', 'jp2', 'jpc', 'jpf', 'jpx'] },
  { modality: 'image', mediaType: 'image/heic', extensions: ['heic', 'heif'], browserAliases: ['image/heif'] },
  { modality: 'video', mediaType: 'video/mp4', extensions: ['mp4'] },
  { modality: 'video', mediaType: 'video/x-msvideo', extensions: ['avi'], browserAliases: ['video/avi'] },
  { modality: 'video', mediaType: 'video/quicktime', extensions: ['mov'] },
  { modality: 'audio', mediaType: 'audio/mpeg', format: 'mp3', extensions: ['mp3'], browserAliases: ['audio/mp3'] },
  { modality: 'audio', mediaType: 'audio/wav', format: 'wav', extensions: ['wav'], browserAliases: ['audio/x-wav', 'audio/wave', 'audio/vnd.wave'] },
  { modality: 'audio', mediaType: 'audio/aac', format: 'aac', extensions: ['aac'] },
  { modality: 'audio', mediaType: 'audio/x-m4a', format: 'm4a', extensions: ['m4a'], browserAliases: ['audio/m4a', 'audio/mp4'] },
]

const BY_EXTENSION = new Map(FORMATS.flatMap(spec => spec.extensions.map(extension => [extension, spec] as const)))
const BY_MEDIA_TYPE = new Map(FORMATS.flatMap(spec => [
  [spec.mediaType, spec] as const,
  ...(spec.browserAliases ?? []).map(alias => [alias, spec] as const),
]))

function normalizedMediaType(value: string): string {
  return value.split(';', 1)[0]!.trim().toLowerCase()
}

function extensionOf(name: string): string | undefined {
  const match = /\.([^.]+)$/u.exec(name)
  return match?.[1]?.toLowerCase()
}

function publicSpec(spec: RegisteredFormat): ArkChatMediaFileSpec {
  return {
    modality: spec.modality,
    mediaType: spec.mediaType,
    ...(spec.format === undefined ? {} : { format: spec.format }),
  }
}

/** Resolve a browser File without inventing MIME types or transforming bytes. */
export function arkChatMediaFileSpec(name: string, browserMediaType = ''): ArkChatMediaFileSpec {
  const extension = extensionOf(name)
  const byExtension = extension === undefined ? undefined : BY_EXTENSION.get(extension)
  const declared = normalizedMediaType(browserMediaType)
  const byDeclared = declared === '' || declared === 'application/octet-stream'
    ? undefined
    : BY_MEDIA_TYPE.get(declared)

  if (byExtension === undefined && byDeclared === undefined) {
    throw new Error(`Ark Chat does not document this media format: ${name || '(unnamed file)'}.`)
  }
  if (byExtension !== undefined && byDeclared !== undefined && byExtension !== byDeclared) {
    throw new Error(`The file extension and browser media type disagree for ${name || '(unnamed file)'}.`)
  }
  if (byExtension !== undefined && byDeclared === undefined
    && declared !== '' && declared !== 'application/octet-stream') {
    throw new Error(`The browser declared an unsupported media type for ${name || '(unnamed file)'}.`)
  }
  return publicSpec(byExtension ?? byDeclared!)
}

export function isArkChatMediaDeclaration(value: unknown): value is ArkChatMediaFileSpec {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const candidate = value as { modality?: unknown; mediaType?: unknown; format?: unknown }
  return FORMATS.some(spec => candidate.modality === spec.modality
    && candidate.mediaType === spec.mediaType
    && candidate.format === spec.format)
}

const ACCEPT_EXTENSIONS = FORMATS.flatMap(spec => spec.extensions.map(extension => `.${extension}`))
const ACCEPT_MEDIA_TYPES = [...new Set(FORMATS.map(spec => spec.mediaType))]

/** Exact picker hint only; the Host repeats validation and Ark remains authoritative. */
export const ARK_CHAT_MEDIA_ACCEPT = [...ACCEPT_EXTENSIONS, ...ACCEPT_MEDIA_TYPES].join(',')

export const ARK_CHAT_MEDIA_FORMATS: readonly Readonly<RegisteredFormat>[] = FORMATS
