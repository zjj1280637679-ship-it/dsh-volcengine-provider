import type { Context } from '@deepseek-ai/cordis'
import {
  CredentialProvider,
  type CredentialInfo,
  type CredentialKey,
  type CredentialRecord,
  type CredentialRecordEntry,
  type CredentialRecordInfo,
  type CredentialRef,
  type ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { FakeArk } from '../support/fake-ark.js'

/** Real settings resolution, validation and live publication over memory storage. */
export class MemorySettings extends SettingsProvider {
  readonly writable = true
  private storedDocument: Record<string, unknown>

  constructor(ctx: Context, document: Record<string, unknown> = {}) {
    super(ctx)
    this.storedDocument = structuredClone(document)
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.storedDocument))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.storedDocument[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

/** Public credential seam; the only supported storage source here is memory. */
export class MemoryCredentials extends CredentialProvider {
  private readonly refs = new Map<string, string>()
  private readonly records = new Map<CredentialKey, CredentialRecord>()

  constructor(ctx: Context, refs: Record<string, string> = {}) {
    super(ctx)
    for (const [ref, value] of Object.entries(refs)) this.refs.set(ref, value)
  }

  resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const value = this.refs.get(ref)
    return Promise.resolve(value ? { value, source: 'memory' } : undefined)
  }

  describe(ref: CredentialRef): Promise<CredentialInfo> {
    const configured = Boolean(this.refs.get(ref))
    return Promise.resolve({ configured, writable: true, ...(configured ? { source: 'memory' } : {}) })
  }

  async set(ref: CredentialRef, value: string): Promise<void> {
    if (!value) throw new Error('Use unset to remove a credential.')
    this.refs.set(ref, value)
    this.notifyUpdated(ref)
  }

  async unset(ref: CredentialRef): Promise<void> {
    this.refs.delete(ref)
    this.notifyUpdated(ref)
  }

  readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    return Promise.resolve(this.records.get(key))
  }

  describeRecord(key: CredentialKey): Promise<CredentialRecordInfo> {
    const record = this.records.get(key)
    return Promise.resolve(record
      ? { configured: true, writable: true, kind: record.kind }
      : { configured: false, writable: true })
  }

  listRecords(): Promise<readonly CredentialRecordEntry[]> {
    return Promise.resolve([...this.records].map(([key, record]) => ({ key, kind: record.kind })))
  }

  async modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    const current = this.records.get(key)
    const next = await mutate(current)
    if (next !== undefined) {
      this.records.set(key, next)
      this.notifyRecordUpdated(key)
    }
    return next ?? current
  }

  async deleteRecord(key: CredentialKey): Promise<void> {
    this.records.delete(key)
    this.notifyRecordUpdated(key)
  }
}

export function enqueueCompletion(fake: FakeArk, text = 'hello from Ark'): void {
  const events = [
    { choices: [{ delta: { content: text }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
    '[DONE]',
  ]
  fake.enqueueResponse({
    headers: { 'content-type': 'text/event-stream' },
    body: events.map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join(''),
  })
}

/** The real runtime stream is also the production loop's adapter boundary. */
export async function prompt(ctx: Context, provider = 'volcengine-standard', model = 'manual-model'): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of ctx.llm.stream({ provider, model, messages: [] })) chunks.push(chunk)
  return chunks
}
