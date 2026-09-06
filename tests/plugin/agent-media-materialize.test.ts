import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'

import {
  createMediaMaterializeTool,
  registerMediaMaterializeTool,
  retainedMediaRelativePath,
  VOLCENGINE_MEDIA_MATERIALIZE_TOOL,
} from '../../src/agent-media-materialize.js'
import { OriginalMediaStore } from '../../src/original-media-store.js'

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0).reverse()) await rm(root, { recursive: true, force: true })
})

async function fixture(): Promise<{
  bytes: Uint8Array
  ctx: Context
  ref: Awaited<ReturnType<OriginalMediaStore['persistVideo']>>
  store: OriginalMediaStore
  workspace: string
}> {
  const storeRoot = await mkdtemp(join(tmpdir(), 'dsh-volcengine-agent-source-'))
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-volcengine-agent-workspace-'))
  roots.push(storeRoot, workspace)
  const ctx = new Context()
  contexts.push(ctx)
  const store = new OriginalMediaStore(storeRoot)
  const bytes = Uint8Array.of(0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 7, 8, 9)
  const ref = await store.persistVideo(bytes)
  return { bytes, ctx, ref, store, workspace }
}

function session(
  workspace: string,
  ref: Awaited<ReturnType<OriginalMediaStore['persistVideo']>>,
  source: 'user' | 'plugin' = 'user',
) {
  return {
    header: { cwd: workspace },
    events: [{
      type: 'user/message',
      data: {
        source: source === 'user' ? { kind: 'user' } : { kind: 'plugin', plugin: 'fixture' },
        content: [{ type: 'volcengine-video', attachment: ref, mediaType: 'video/mp4' }],
      },
    }],
  }
}

function execution(activeSession: ReturnType<typeof session>) {
  return {
    agent: { session: activeSession },
    signal: new AbortController().signal,
  }
}

describe('agent source-file materialization', () => {
  it('copies direct-user media into a stable session path and reuses it after restart', async () => {
    const { bytes, ctx, ref, store, workspace } = await fixture()
    const first = await createMediaMaterializeTool(ctx, store).execute(
      { attachment_id: ref.attachmentId },
      execution(session(workspace, ref)),
    )

    expect(first).toMatchObject({
      bytes: bytes.byteLength,
      media_type: 'video/mp4',
      name: 'video.mp4',
      reused: false,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })
    expect(first.path.startsWith(join(workspace, '.dsh-media'))).toBe(true)
    expect(await readFile(first.path)).toEqual(Buffer.from(bytes))

    const restarted = new OriginalMediaStore(store.root)
    const second = await createMediaMaterializeTool(ctx, restarted).execute(
      { attachment_id: ref.attachmentId },
      execution(session(workspace, ref)),
    )
    expect(second).toEqual({ ...first, reused: true })
    expect((await readdir(join(workspace, '.dsh-media', first.sha256))).filter(name => name.endsWith('.part')))
      .toEqual([])
  })

  it('rejects a foreign session, a plugin-authored block, and read-only policy', async () => {
    const { ctx, ref, store, workspace } = await fixture()
    const tool = createMediaMaterializeTool(ctx, store)
    await expect(tool.execute(
      { attachment_id: ref.attachmentId },
      execution({ header: { cwd: workspace }, events: [] }),
    )).rejects.toThrow('not owned by a direct user message')
    await expect(tool.execute(
      { attachment_id: ref.attachmentId },
      execution(session(workspace, ref, 'plugin')),
    )).rejects.toThrow('not owned by a direct user message')

    const readOnly = {
      get: (name: string) => name === 'sandboxPolicy'
        ? { resolve: () => ({ mode: 'read-only', workspaceRoot: workspace }) }
        : undefined,
    } as unknown as Context
    await expect(createMediaMaterializeTool(readOnly, store).execute(
      { attachment_id: ref.attachmentId },
      execution(session(workspace, ref)),
    )).rejects.toThrow('session is read-only')
  })

  it('exposes only its deterministic retained path and disables the handle on unload', async () => {
    const { ref, store } = await fixture()
    let registered: ReturnType<typeof createMediaMaterializeTool> | undefined
    let unload: (() => void) | undefined
    let disposed = false
    const fake = {
      inject: (
        _dependencies: readonly string[],
        callback: (scope: Context) => (() => void) | void,
      ) => { unload = callback(fake as unknown as Context) ?? undefined },
      get: (name: string) => name === 'tools' ? {
        register: (definition: ReturnType<typeof createMediaMaterializeTool>) => {
          registered = definition
          return () => { disposed = true }
        },
      } : undefined,
    } as unknown as Context

    const bridge = registerMediaMaterializeTool(fake, store)
    const description = bridge.describe({
      type: 'volcengine-video', attachment: ref, mediaType: 'video/mp4',
    })

    expect(registered?.name).toBe(VOLCENGINE_MEDIA_MATERIALIZE_TOOL)
    expect(description).toContain(ref.attachmentId)
    expect(description).toContain(VOLCENGINE_MEDIA_MATERIALIZE_TOOL)
    expect(description).not.toContain(store.root)

    const retained = retainedMediaRelativePath(store, ref)
    expect(bridge.describe({
      type: 'volcengine-video', attachment: ref, mediaType: 'video/mp4', sourcePath: retained,
    })).toContain(`path=${JSON.stringify(retained)}`)
    const forged = '..\\private\\secret.mp4'
    const forgedDescription = bridge.describe({
      type: 'volcengine-video', attachment: ref, mediaType: 'video/mp4', sourcePath: forged,
    })
    expect(forgedDescription).not.toContain(forged)
    expect(forgedDescription).not.toContain('path=')

    unload?.()
    expect(disposed).toBe(true)
    expect(bridge.describe({
      type: 'volcengine-video', attachment: ref, mediaType: 'video/mp4', sourcePath: retained,
    })).toBeUndefined()
  })
})
