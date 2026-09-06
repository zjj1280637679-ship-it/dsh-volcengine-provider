import { lstat, mkdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'

import type { MediaInputBlock, MediaSourceBridge } from './chat/serialize.js'
import {
  isSafeOriginalMediaName,
  type OriginalMediaAttachmentRef,
  OriginalMediaStore,
} from './original-media-store.js'

export const VOLCENGINE_MEDIA_MATERIALIZE_TOOL = 'volcengine_media_materialize'
const RETAINED_MEDIA_DIRECTORY = '.dsh-media'

export interface MediaMaterializationSession {
  readonly header?: { readonly cwd?: unknown }
  readonly events?: readonly unknown[]
}

interface ToolExecutionLike {
  readonly agent?: { readonly session?: MediaMaterializationSession }
  readonly signal: AbortSignal
}

export interface MaterializedMediaToolResult {
  readonly bytes: number
  readonly media_type: string
  readonly name: string
  readonly path: string
  readonly reused: boolean
  readonly sha256: string
}

export interface MediaMaterializeToolDefinition {
  readonly name: typeof VOLCENGINE_MEDIA_MATERIALIZE_TOOL
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly output: {
    readonly schema: Record<string, unknown>
    render(args: unknown, value: unknown): { readonly type: 'text'; readonly text: string }[]
  }
  execute(args: unknown, exec: ToolExecutionLike): Promise<MaterializedMediaToolResult>
}

interface SessionMediaSource {
  readonly attachment: OriginalMediaAttachmentRef
  readonly mediaType: string
}

interface ToolRegistryLike {
  register(definition: MediaMaterializeToolDefinition): () => void
}

interface SandboxPolicyLike {
  resolve(request: { readonly session: MediaMaterializationSession }): unknown
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function systemCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined
}

function containedBy(root: string, candidate: string): boolean {
  const child = relative(root, candidate)
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`))
}

function portableCopyName(name: string): string {
  // The content itself remains byte-for-byte unchanged. Only the working-copy
  // basename is made portable across Windows and POSIX workspaces.
  let safe = name.replace(/[<>:"|?*]/gu, '_').replace(/[ .]+$/u, '_')
  if (safe === '') safe = 'uploaded-media'
  const stem = safe.split('.', 1)[0]!
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(stem)) safe = `_${safe}`
  const characters = Array.from(safe)
  if (characters.length <= 120) return safe
  const extensionMatch = /(\.[^.]{1,20})$/u.exec(safe)
  const extension = extensionMatch?.[1] ?? ''
  const base = extension === '' ? safe : safe.slice(0, -extension.length)
  return `${Array.from(base).slice(0, 120 - Array.from(extension).length).join('')}${extension}`
}

/** Stable path stored in the message; it remains meaningful if the workspace moves. */
export function retainedMediaRelativePath(
  store: OriginalMediaStore,
  attachment: OriginalMediaAttachmentRef,
): string {
  return join(RETAINED_MEDIA_DIRECTORY, store.hashOf(attachment), portableCopyName(attachment.name))
}

async function ensureManagedDirectory(path: string, parent: string): Promise<string> {
  try {
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error('The managed media workspace path is not a regular directory.')
    }
  } catch (cause) {
    if (systemCode(cause) !== 'ENOENT') throw cause
    try {
      await mkdir(path, { mode: 0o700 })
    } catch (mkdirCause) {
      if (systemCode(mkdirCause) !== 'EEXIST') throw mkdirCause
    }
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error('The managed media workspace path is not a regular directory.')
    }
  }
  const canonical = await realpath(path)
  if (!containedBy(parent, canonical)) {
    throw new Error('The managed media workspace path escaped the session workspace.')
  }
  return canonical
}

function mediaSourceFromSession(
  session: MediaMaterializationSession,
  attachmentId: string,
  store: OriginalMediaStore,
): SessionMediaSource | undefined {
  const events = session.events
  if (!Array.isArray(events)) return undefined
  for (let eventIndex = events.length - 1; eventIndex >= 0; eventIndex--) {
    const event = events[eventIndex]
    if (!plainRecord(event) || event.type !== 'user/message' || !plainRecord(event.data)) continue
    const message = event.data
    if (!plainRecord(message.source) || message.source.kind !== 'user' || !Array.isArray(message.content)) continue
    for (const raw of message.content) {
      if (!plainRecord(raw)
        || (raw.type !== 'volcengine-image' && raw.type !== 'volcengine-video' && raw.type !== 'volcengine-audio')
        || !plainRecord(raw.attachment) || raw.attachment.attachmentId !== attachmentId
        || typeof raw.mediaType !== 'string' || raw.mediaType.trim() === '') continue
      const attachment = raw.attachment
      if (typeof attachment.attachmentId !== 'string'
        || !isSafeOriginalMediaName(attachment.name)
        || typeof attachment.bytes !== 'number' || !Number.isSafeInteger(attachment.bytes)
        || attachment.bytes <= 0 || !store.owns(attachment as unknown as OriginalMediaAttachmentRef)) continue
      return {
        attachment: attachment as unknown as OriginalMediaAttachmentRef,
        mediaType: raw.mediaType,
      }
    }
  }
  return undefined
}

async function approvedWorkspace(
  ctx: Context,
  session: MediaMaterializationSession,
): Promise<string> {
  const cwd = session.header?.cwd
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) {
    throw new Error('This session does not have an absolute workspace for media materialization.')
  }
  const workspace = await realpath(cwd)
  const info = await lstat(workspace)
  if (!info.isDirectory()) throw new Error('The session workspace is unavailable.')

  const policy = ctx.get('sandboxPolicy') as SandboxPolicyLike | undefined
  if (policy === undefined) return workspace
  let resolved: unknown
  try {
    resolved = policy.resolve({ session })
  } catch {
    throw new Error('The session file policy could not be resolved.')
  }
  if (!plainRecord(resolved)
    || (resolved.mode !== 'read-only' && resolved.mode !== 'workspace-write'
      && resolved.mode !== 'danger-full-access')
    || typeof resolved.workspaceRoot !== 'string' || !isAbsolute(resolved.workspaceRoot)) {
    throw new Error('The session file policy could not be resolved.')
  }
  if (resolved.mode === 'read-only') {
    throw new Error('The session is read-only; change its file policy before materializing media.')
  }
  if (resolved.mode === 'workspace-write') {
    const policyRoot = await realpath(resolved.workspaceRoot)
    if (!containedBy(policyRoot, workspace)) {
      throw new Error('The session workspace is outside its writable file-policy root.')
    }
  }
  return workspace
}

function parseAttachmentId(args: unknown): string {
  if (!plainRecord(args)
    || Object.keys(args).some(key => key !== 'attachment_id')
    || typeof args.attachment_id !== 'string'
    || !/^volcengine-original:v1:sha256:[a-f0-9]{64}$/u.test(args.attachment_id)) {
    throw new Error('Pass exactly one valid attachment_id from an uploaded-source handle.')
  }
  return args.attachment_id
}

/** Create or reuse the deterministic verified copy retained by a session message. */
export async function materializeMediaCopy(
  ctx: Context,
  store: OriginalMediaStore,
  session: MediaMaterializationSession,
  attachment: OriginalMediaAttachmentRef,
  mediaType: string,
  signal?: AbortSignal,
): Promise<MaterializedMediaToolResult> {
  const workspace = await approvedWorkspace(ctx, session)
  signal?.throwIfAborted()
  const mediaRoot = await ensureManagedDirectory(join(workspace, RETAINED_MEDIA_DIRECTORY), workspace)
  const sha256 = store.hashOf(attachment)
  const digestRoot = await ensureManagedDirectory(join(mediaRoot, sha256), mediaRoot)
  const name = portableCopyName(attachment.name)
  const relativePath = retainedMediaRelativePath(store, attachment)
  const path = join(workspace, relativePath)
  const result = await store.copyTo(attachment, path, signal, digestRoot)
  return {
    bytes: result.bytes,
    media_type: mediaType,
    name,
    path,
    reused: result.reused,
    sha256: result.sha256,
  }
}

/** Build the raw structural tool without taking a runtime dependency on one Host release. */
export function createMediaMaterializeTool(
  ctx: Context,
  store: OriginalMediaStore,
): MediaMaterializeToolDefinition {
  return {
    name: VOLCENGINE_MEDIA_MATERIALIZE_TOOL,
    description: 'Copy one original Volcengine media upload owned by this conversation into the current session workspace. Use the returned path before invoking filesystem, shell, ffmpeg, or other file-based tools. The private stored original is never exposed or modified, and an existing different destination is never overwritten.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        attachment_id: {
          type: 'string',
          description: 'Opaque attachment_id shown in the uploaded-source handle beside the user media.',
        },
      },
      required: ['attachment_id'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          bytes: { type: 'integer' },
          media_type: { type: 'string' },
          name: { type: 'string' },
          path: { type: 'string' },
          reused: { type: 'boolean' },
          sha256: { type: 'string' },
        },
        required: ['bytes', 'media_type', 'name', 'path', 'reused', 'sha256'],
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const attachmentId = parseAttachmentId(args)
      exec.signal.throwIfAborted()
      const session = exec.agent?.session
      if (session === undefined) {
        throw new Error('This tool requires an active Harness session.')
      }
      const source = mediaSourceFromSession(session, attachmentId, store)
      if (source === undefined) {
        throw new Error('That media attachment is not owned by a direct user message in this session.')
      }
      exec.signal.throwIfAborted()
      return materializeMediaCopy(ctx, store, session, source.attachment, source.mediaType, exec.signal)
    },
  }
}

/** Register the optional tool and expose only an opaque, model-visible handle. */
export function registerMediaMaterializeTool(
  ctx: Context,
  store: OriginalMediaStore,
): MediaSourceBridge {
  let activeRegistrations = 0
  const injectable = ctx as unknown as {
    inject(dependencies: readonly string[], callback: (scope: Context) => (() => void) | void): void
  }
  injectable.inject(['tools'], scope => {
    const registry = scope.get('tools') as ToolRegistryLike | undefined
    if (registry === undefined || typeof registry.register !== 'function') return
    const dispose = registry.register(createMediaMaterializeTool(scope, store))
    activeRegistrations++
    return () => {
      activeRegistrations--
      dispose()
    }
  })
  return {
    toolName: VOLCENGINE_MEDIA_MATERIALIZE_TOOL,
    describe(block: MediaInputBlock): string | undefined {
      if (activeRegistrations <= 0 || block.type === 'image' || !store.owns(block.attachment)) return undefined
      let expectedPath: string
      try {
        expectedPath = retainedMediaRelativePath(
          store, block.attachment as OriginalMediaAttachmentRef,
        )
      } catch {
        return undefined
      }
      const retainedPath = typeof block.sourcePath === 'string'
        && block.sourcePath === expectedPath
        ? ` path=${JSON.stringify(block.sourcePath)}; attachment_id=${JSON.stringify(block.attachment.attachmentId)}; restore_tool=${VOLCENGINE_MEDIA_MATERIALIZE_TOOL}`
        : ` attachment_id=${JSON.stringify(block.attachment.attachmentId)}; materialize_tool=${VOLCENGINE_MEDIA_MATERIALIZE_TOOL}`
      return `[Source file:${retainedPath}]`
    },
  }
}
