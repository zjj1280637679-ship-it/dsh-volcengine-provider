import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

interface Snapshot<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

interface HostInputState {
  readonly draft: string
  readonly draftRev: number
  readonly phase: 'plain' | 'adjudicating' | 'claimed' | 'submitting'
  readonly occurrences: readonly {
    readonly source: string
    readonly ref: string
    readonly offset: number
    readonly length: number
  }[]
}

export interface HostInput {
  readonly state: Snapshot<HostInputState>
  readonly notices: Snapshot<{ readonly level: string; readonly text: string } | null>
  setDraft(text: string): void
  insertReference(reference: {
    source: string; ref: string; label: string; clipboardText: string; appearance?: 'file'
  }, span: { start: number; end: number; draftRev: number }): boolean
  notify(level: 'info' | 'error', text: string): void
  submit(mode: 'queue' | 'steer'): void
  dispose(): void
}

interface HostInputOptions {
  readonly defaultSink: (
    text: string, attachments: readonly unknown[], mode: 'queue' | 'steer', signal: AbortSignal,
  ) => Promise<{ kind: 'success' | 'error'; text?: string }>
  readonly serialize: (source: string, ref: string, signal: AbortSignal) => Promise<string>
  readonly adjudicate: (line: string, signal: AbortSignal) => Promise<undefined>
}

/** Only snapshot delivery is substituted; the shipped editor and coordinate code run unchanged. */
function createSnapshotStore<T>(initial: T): Snapshot<T> & { set(next: T): void } {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    set(next) {
      if (Object.is(value, next)) return
      value = next
      for (const listener of [...listeners]) listener()
    },
  }
}

type HostInputConstructor = new (dependencies: Record<string, unknown>) => HostInput
let constructor: HostInputConstructor | undefined

function installedHostInput(): HostInputConstructor {
  if (constructor !== undefined) return constructor
  const require = createRequire(import.meta.url)
  const source = readFileSync(require.resolve('@deepseek-ai/dsh-client-ui-conversation/client'), 'utf8')
  const returnOffset = source.lastIndexOf('return module.exports;')
  if (returnOffset < 0 || !source.includes('var SessionInputShell = class')) {
    throw new Error('The installed Harness composer can no longer be inspected by this fixture.')
  }
  // Expose the package-private constructor without rewriting its implementation.
  const exposed = source.slice(0, returnOffset)
    + 'module.exports.SessionInputShell = SessionInputShell; '
    + source.slice(returnOffset)
  let factory: ((require: (name: string) => unknown) => { SessionInputShell: HostInputConstructor }) | undefined
  const loader = { __ModuleLoader__: { load(row: { factory: typeof factory }) { factory = row.factory } } }
  new Function('window', exposed)(loader)
  if (factory === undefined) throw new Error('The installed Harness composer did not register its factory.')
  constructor = factory(name => {
    if (name === '@deepseek-ai/dsh-client-store') return { createSnapshotStore }
    // These namespaces are only used by renderers; this fixture drives the headless editor.
    if (name === '@deepseek-ai/dsh-client-ui-slots' || name === '@deepseek-ai/dsh-client-ui-primitives') return {}
    return require(name)
  }).SessionInputShell
  return constructor
}

export function createHostInput(options: HostInputOptions): HostInput {
  const Input = installedHostInput()
  const triggers = {
    track: () => {},
    lexicon: { getSnapshot: () => new Map(), subscribe: () => () => {} },
    serializeReference: options.serialize,
    adjudicate: options.adjudicate,
  }
  return new Input({
    actx: {},
    inputTriggers: () => triggers,
    defaultSink: options.defaultSink,
    commandAttachments: { serialize: async () => [], release: () => {}, unsupportedNotice: () => '' },
  })
}
