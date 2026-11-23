import type { JsonlMessageEntry, JsonlSystemEntry } from '@shared/lib/types/agent'
import { deliverFileInputSchema } from '@shared/lib/tools/deliver-file/schema'
import { getDeliveredFileMetadata } from '@shared/lib/tools/deliver-file/definition'
import { sanitizeUploadFilename } from '@shared/lib/utils/path-safety'
import {
  isTaskNotificationMessage,
  isToolResultOnlyMessage,
  parseCommandMessage,
  transformMessages,
} from '@shared/lib/utils/message-transform'
import { isSystemMessageText } from '@shared/lib/utils/system-message'
import { isSyntheticPlaceholderMessage } from '@shared/lib/utils/synthetic-message'
import { parseSignInMethodRequestMessage } from '@shared/lib/utils/sign-in-method-request'
import { integrationTimestamp } from '@shared/lib/agent-integrations/message-display-schema'

// The CLI's stop marker; the renderer draws it bare, as no one's message.
const INTERRUPT_PREFIX = '[Request interrupted by user'

/** A user-role line no person wrote; a person's message has no kind. `injected`: text the runtime adds (skill instructions, image notes). */
export type TranscriptLineKind =
  | 'tool_result'
  | 'task_notification'
  | 'compact_summary'
  | 'injected'
  | 'interrupt'
  | 'system'
  | 'command_output'

export type TranscriptSender =
  | { kind: 'person'; id: string; name: string }
  | { kind: 'agent'; slug: string }
  | { kind: 'integration'; provider: string }

export type TranscriptMessage = {
  role: string
  content: string
  toolName?: string
  at?: string
  kind?: TranscriptLineKind
  forked?: true
  sender?: TranscriptSender
}

/** A view line with its transcript uuid, which senders join on. */
export type TranscriptViewLine = TranscriptMessage & { id?: string }

export type CompactedMessage = TranscriptViewLine & {
  spoken: string
}

export interface DeliveredAgentFile {
  /** Stable authorization lookup key; filename is display metadata only. */
  deliveryId: string
  filename: string
  description?: string
  sizeBytes: number
}

export interface ResolvedDeliveredAgentFile extends DeliveredAgentFile {
  filePath: string
}

export interface TranscriptView {
  messages: TranscriptViewLine[]
  total: number
  deliveredFiles: DeliveredAgentFile[]
}

type TranscriptEntry = JsonlMessageEntry | JsonlSystemEntry

const DELIVER_FILE_TOOL = 'mcp__user-input__deliver_file'

/** Project completed file deliveries from the full persisted transcript. */
function collectResolvedDeliveredFiles(
  entries: Array<JsonlMessageEntry | JsonlSystemEntry>,
): ResolvedDeliveredAgentFile[] {
  const delivered: ResolvedDeliveredAgentFile[] = []
  const seenDeliveryIds = new Set<string>()

  for (const item of transformMessages(entries)) {
    if (item.type !== 'assistant') continue

    for (const toolCall of item.toolCalls) {
      if (
        toolCall.name !== DELIVER_FILE_TOOL ||
        toolCall.isError !== false ||
        seenDeliveryIds.has(toolCall.id)
      ) continue

      const input = deliverFileInputSchema.safeParse(toolCall.input)
      if (!input.success) continue

      const metadata = getDeliveredFileMetadata((toolCall as { result?: unknown }).result)
      if (!metadata) continue

      seenDeliveryIds.add(toolCall.id)
      delivered.push({
        deliveryId: toolCall.id,
        filePath: input.data.filePath,
        filename: sanitizeUploadFilename(input.data.filePath),
        ...(input.data.description !== undefined ? { description: input.data.description } : {}),
        sizeBytes: metadata.sizeBytes,
      })
    }
  }

  return delivered
}

export function collectDeliveredFiles(
  entries: Array<JsonlMessageEntry | JsonlSystemEntry>,
): DeliveredAgentFile[] {
  return collectResolvedDeliveredFiles(entries).map(({ filePath: _filePath, ...file }) => file)
}

/**
 * Whether `entry` is part of a delivery: a line with a `deliver_file` call
 * (`onlyCallId` narrows it to one call), or a line with a result for a call
 * seen so far. These are the only lines `collectResolvedDeliveredFiles` reads
 * a delivery from, so they alone give it the same answer as the whole
 * transcript. A result line follows its call line.
 */
function isDeliveryLine(entry: TranscriptEntry, calls: Set<string>, onlyCallId?: string): boolean {
  if (entry.type === 'system' || typeof entry.message.content === 'string') return false
  let delivery = false
  for (const block of entry.message.content) {
    if (block.type === 'tool_use' && block.name === DELIVER_FILE_TOOL && (onlyCallId === undefined || block.id === onlyCallId)) {
      calls.add(block.id)
      delivery = true
    } else if (block.type === 'tool_result' && calls.has(block.tool_use_id)) {
      delivery = true
    }
  }
  return delivery
}

/** The delivered file `deliveryId`, holding only the lines of that delivery. */
export async function findDeliveredFile(
  entries: AsyncIterable<TranscriptEntry>,
  deliveryId: string,
): Promise<ResolvedDeliveredAgentFile | undefined> {
  const lines: TranscriptEntry[] = []
  const calls = new Set<string>()
  for await (const entry of entries) {
    if (isDeliveryLine(entry, calls, deliveryId)) lines.push(entry)
  }
  return collectResolvedDeliveredFiles(lines).find((file) => file.deliveryId === deliveryId)
}

const INTERNAL_STUB: TranscriptMessage = {
  role: 'system',
  content: 'tool calls + thinking',
}

/** A user-role line's kind, by the markers the app's chat hides it on. */
function lineKind(entry: JsonlMessageEntry): TranscriptLineKind | undefined {
  if (isToolResultOnlyMessage(entry)) return 'tool_result'
  if (isTaskNotificationMessage(entry)) return 'task_notification'
  if (entry.isCompactSummary) return 'compact_summary'
  if ('isMeta' in entry && entry.isMeta) return 'injected'
  const content = entry.message.content
  const text = typeof content === 'string'
    ? content
    : content.map((block) => (block.type === 'text' ? block.text : '')).join('')
  if (isSystemMessageText(text) || parseSignInMethodRequestMessage(text)) return 'system'
  if (text.startsWith(INTERRUPT_PREFIX)) return 'interrupt'
  if (parseCommandMessage(text)?.type === 'command-output') return 'command_output'
  return undefined
}

function lineFacts(entry: JsonlMessageEntry | JsonlSystemEntry): Omit<TranscriptViewLine, 'role' | 'content'> {
  const kind = entry.type === 'user' ? lineKind(entry) : undefined
  const at = integrationTimestamp(entry.timestamp)
  return {
    ...(entry.uuid ? { id: entry.uuid } : {}),
    ...(at ? { at } : {}),
    ...(kind ? { kind } : {}),
    ...(entry.forkedFrom ? { forked: true as const } : {}),
  }
}

/**
 * Convert a JSONL message entry into a compact { role, content, spoken } shape.
 * Strips internal SDK fields. `content` is today's compact view (tool stubs
 * kept). `spoken` is text-only, empty when the entry was only tools/thinking.
 */
export function compactMessage(entry: JsonlMessageEntry | JsonlSystemEntry): CompactedMessage | null {
  if (entry.type === 'system') {
    const content = entry.subtype === 'compact_boundary'
      ? '[context compacted]'
      : `[system: ${entry.subtype ?? 'unknown'}]`
    return { role: 'system', ...lineFacts(entry), content, spoken: content }
  }
  const msg = entry.message
  const facts = lineFacts(entry)
  if (typeof msg.content === 'string') {
    return { role: entry.type, ...facts, content: msg.content, spoken: msg.content }
  }
  const parts: string[] = []
  const spokenParts: string[] = []
  let firstToolName: string | undefined
  let hadThinking = false
  for (const block of msg.content) {
    if (block.type === 'text') {
      parts.push(block.text)
      spokenParts.push(block.text)
    } else if (block.type === 'tool_use') {
      firstToolName = firstToolName ?? block.name
      parts.push(`[tool_use: ${block.name}]`)
    } else if (block.type === 'tool_result') {
      const text = Array.isArray(block.content)
        ? block.content
            .filter((p) => p && typeof p === 'object' && 'text' in p)
            .map((p) => (p as { text: string }).text)
            .join('\n')
        : typeof block.content === 'string'
          ? block.content
          : ''
      parts.push(text ? `[tool_result] ${text}` : '[tool_result]')
    } else if (block.type === 'thinking') {
      hadThinking = true
    }
  }
  let content = parts.join('\n').trim()
  if (!content) {
    content = hadThinking ? '[thinking only — no text response]' : '[no text response]'
  }
  return {
    role: entry.type,
    ...facts,
    content,
    spoken: spokenParts.join('\n').trim(),
    ...(firstToolName ? { toolName: firstToolName } : {}),
  }
}

const fullLine = ({ spoken: _spoken, ...line }: CompactedMessage): TranscriptViewLine => line
const spokenLine = ({ spoken, toolName: _toolName, ...line }: CompactedMessage): TranscriptViewLine => ({ ...line, content: spoken })

export function toTranscriptView(
  compacted: CompactedMessage[],
  fullTranscript: boolean,
): TranscriptViewLine[] {
  if (fullTranscript) {
    return compacted.map(fullLine)
  }
  const out: TranscriptViewLine[] = []
  let pendingInternal = false
  for (const message of compacted) {
    if (message.spoken.length > 0) {
      if (pendingInternal) {
        out.push(INTERNAL_STUB)
        pendingInternal = false
      }
      out.push(spokenLine(message))
      continue
    }
    pendingInternal = true
  }
  if (pendingInternal) {
    out.push(INTERNAL_STUB)
  }
  return out
}

/**
 * The view of a transcript (`toTranscriptView`, newest `limit` messages) and
 * its delivered files, in one pass that holds each message's compact form and
 * the delivery lines, never the parsed transcript.
 */
export async function readTranscriptView(
  entries: AsyncIterable<TranscriptEntry>,
  opts: { fullTranscript?: boolean; limit?: number } = {},
): Promise<TranscriptView> {
  const compacted: CompactedMessage[] = []
  const deliveryLines: TranscriptEntry[] = []
  const deliveryCalls = new Set<string>()
  const seen = new Set<string>()
  let previousEntry: TranscriptEntry | undefined
  for await (const entry of entries) {
    if (isDeliveryLine(entry, deliveryCalls)) deliveryLines.push(entry)
    // A hook stop's user echo, by the app's rule (message-transform), checked before the replay drop.
    if (
      entry.type === 'system' && entry.subtype === 'informational' &&
      previousEntry?.type === 'user' && previousEntry.message.content === entry.content
    ) {
      const echo = compacted.at(-1)
      if (echo?.id === previousEntry.uuid) echo.kind = 'system'
    }
    previousEntry = entry
    // Dropped as the app drops them: placeholder replies and replayed lines.
    if (isSyntheticPlaceholderMessage(entry)) continue
    if (entry.uuid) {
      if (seen.has(entry.uuid)) continue
      seen.add(entry.uuid)
    }
    const message = compactMessage(entry)
    if (message) compacted.push(message)
  }
  const view = toTranscriptView(compacted, opts.fullTranscript === true)
  return {
    messages: opts.limit ? view.slice(-opts.limit) : view,
    total: view.length,
    deliveredFiles: collectDeliveredFiles(deliveryLines),
  }
}
