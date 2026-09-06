export const NATIVE_MEDIA_MARKER_NAME_PREFIX = '__dsh_volc_media_v1_'
export const NATIVE_MEDIA_MARKER_PREFIX = `/${NATIVE_MEDIA_MARKER_NAME_PREFIX}`

const BUNDLE_ID_PATTERN = /^[a-f0-9]{32}$/u
const MARKER_PATTERN = /^\/__dsh_volc_media_v1_([a-f0-9]{32})$/u

export interface NativeMediaMarkerOccurrence {
  readonly marker: string
  readonly bundleId: string
  readonly start: number
  readonly end: number
}

export function isNativeMediaBundleId(value: unknown): value is string {
  return typeof value === 'string' && BUNDLE_ID_PATTERN.test(value)
}

export function formatNativeMediaMarker(bundleId: string): string {
  if (!isNativeMediaBundleId(bundleId)) throw new Error('The native media bundle id is invalid.')
  return `${NATIVE_MEDIA_MARKER_PREFIX}${bundleId}`
}

/** Parse one canonical marker, without trimming or accepting aliases. */
export function parseNativeMediaMarker(value: string): string | undefined {
  return MARKER_PATTERN.exec(value)?.[1]
}

/**
 * Find only standalone marker lexemes. Punctuation is deliberately not a
 * boundary: the composer mirror must preserve an unambiguous occurrence.
 */
export function nativeMediaMarkerOccurrences(text: string): readonly NativeMediaMarkerOccurrence[] {
  const pattern = /\/__dsh_volc_media_v1_([a-f0-9]{32})/gu
  const occurrences: NativeMediaMarkerOccurrence[] = []
  for (const match of text.matchAll(pattern)) {
    const start = match.index
    const marker = match[0]
    const end = start + marker.length
    const before = start === 0 || /\s/u.test(text[start - 1]!)
    const after = end === text.length || /\s/u.test(text[end]!)
    if (before && after) occurrences.push({ marker, bundleId: match[1]!, start, end })
  }
  return occurrences
}

export function nativeMediaMarkerIds(text: string): string[]
export function nativeMediaMarkerIds(text: string, withOccurrences: true): NativeMediaMarkerOccurrence[]
export function nativeMediaMarkerIds(
  text: string,
  withOccurrences = false,
): string[] | NativeMediaMarkerOccurrence[] {
  const occurrences = [...nativeMediaMarkerOccurrences(text)]
  return withOccurrences ? occurrences : occurrences.map(occurrence => occurrence.bundleId)
}

/** Return the consecutive standalone markers before the first text lexeme. */
export function parseLeadingNativeMediaMarkers(text: string): string[] {
  const occurrences = nativeMediaMarkerOccurrences(text)
  const bundleIds: string[] = []
  let cursor = 0
  for (const occurrence of occurrences) {
    if (!/^\s*$/u.test(text.slice(cursor, occurrence.start))) break
    bundleIds.push(occurrence.bundleId)
    cursor = occurrence.end
  }
  return bundleIds
}
