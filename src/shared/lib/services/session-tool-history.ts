import { transformMessages, type TransformedItem } from '@shared/lib/utils/message-transform'
import type { JsonlMessageEntry, JsonlSystemEntry } from '@shared/lib/types/agent'

/** Read all matching launches and their results, independent of the chat's visible page. */
export async function readSessionToolHistory(
  entries: AsyncIterable<JsonlMessageEntry | JsonlSystemEntry>,
  names: string[],
): Promise<TransformedItem[]> {
  const wanted = new Set(names)
  const callIds = new Set<string>()
  const selected: JsonlMessageEntry[] = []
  for await (const entry of entries) {
    if (entry.type === 'system' || typeof entry.message.content === 'string') continue
    const content = entry.message.content.filter(block => {
      if (block.type === 'tool_use' && wanted.has(block.name)) {
        callIds.add(block.id)
        return true
      }
      return block.type === 'tool_result' && callIds.has(block.tool_use_id)
    })
    if (content.length) selected.push({ ...entry, message: { ...entry.message, content } })
  }
  return transformMessages(selected)
}
