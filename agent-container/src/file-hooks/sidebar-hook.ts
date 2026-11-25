import * as fs from 'fs'
import { isDeepStrictEqual } from 'util'
import { FileHook, type FileHookChangeResult, type FileHookContext, type FileHookReadResult, type FileHookWriteResult } from './file-hook'
import { sidebarFileSchema } from './sidebar-schema'
import { callHost, XAgentError } from '../tools/agents/host-client'
import { sidebarFileReadResultSchema, sidebarFileWriteResultSchema } from '../tools/agents/host-response-schemas'
import { editedContent } from './github-conflict-hook'

const SIDEBAR_PATH = '/workspace/sidebar.json'

const READ_HINT = `This is the sidebar of the person you are working for: how they group agents into sections in the app's left nav. It is that person's own; nobody else's sidebar changes. The app writes it fresh each time you read it, and applies each change you make with Edit or Write. Shell commands (cat, echo) skip both, so use Read and Edit.

Format: a JSON array of sections, in sidebar order, each with:
- "id": the section's id. "root" is Your Agents, which holds every agent not in another section and cannot be renamed or deleted. A new section needs a new id of your choosing, such as "sales-1".
- "name": the section's name.
- "agents": the slugs of the agents in it, in order, as list_agents prints them.

Reorder entries to move sections, change a name to rename, add an entry to create a section, remove one to delete it (its agents go to Your Agents), and move a slug to file an agent. Agents you cannot list are not shown and keep their place.`

/**
 * The person's sidebar sections as a file. The host owns it: it writes the
 * file before each read, for the person behind this session, and applies each
 * change only when the file it started from is still current.
 */
export class SidebarFileHook extends FileHook {
  pattern(): string {
    return SIDEBAR_PATH
  }

  matches(filePath: string): boolean {
    return filePath === SIDEBAR_PATH
  }

  async beforeRead(_filePath: string, { sessionId }: FileHookContext): Promise<Pick<FileHookWriteResult, 'error'>> {
    try {
      const read = await callHost('sidebar-sections', {}, sidebarFileReadResultSchema, { callerSessionId: sessionId })
      if (read.sections === null) {
        await removeCopy()
        return { error: read.reason }
      }
      await fs.promises.writeFile(SIDEBAR_PATH, `${JSON.stringify(read.sections, null, 2)}\n`)
      return {}
    } catch (error) {
      console.warn('[SidebarFileHook] Failed to refresh sidebar.json:', error instanceof Error ? error.message : String(error))
      await removeCopy()
      // A 4xx is the app refusing, with its reason; anything else may pass on a later try.
      return { error: isRefusal(error) ? error.message : 'The sidebar could not be loaded from the app. Try again later.' }
    }
  }

  onRead(): FileHookReadResult {
    return { additionalContext: READ_HINT }
  }

  onWrite(_filePath: string, content: string): FileHookWriteResult {
    return validate(content)
  }

  onEdit(_filePath: string, contentAfterEdit: string): FileHookWriteResult {
    return validate(contentAfterEdit)
  }

  onEditReply(filePath: string, reply: unknown): FileHookWriteResult | null {
    const content = editedContent(reply)
    return content === null ? null : this.onEdit(filePath, content)
  }

  async onChange(_filePath: string, before: string | null, after: string, { sessionId }: FileHookContext): Promise<FileHookChangeResult> {
    try {
      const { sections } = await callHost('sidebar-sections', { before, after }, sidebarFileWriteResultSchema, { callerSessionId: sessionId })
      // The copy becomes what was applied (an agent left out moved, a name lost its line breaks), so the next edit starts from it.
      const applied = `${JSON.stringify(sections, null, 2)}\n`
      if (sameFile(applied, after)) return {}
      await fs.promises.writeFile(SIDEBAR_PATH, applied)
      return { warning: 'The sidebar changed. sidebar.json now shows it as the app applied it: read it before editing again.' }
    } catch (error) {
      await removeCopy()
      // A 4xx is the app refusing; a network error or a 5xx may have come after the change landed.
      const outcome = isRefusal(error)
        ? `The sidebar did not change: ${error.message}`
        : 'The change could not be confirmed.'
      return { warning: `${outcome} sidebar.json was removed. Read it again for the current sidebar.` }
    }
  }
}

function validate(content: string): FileHookWriteResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch (e) {
    return { error: `sidebar.json must contain valid JSON: ${(e as Error).message}` }
  }
  const result = sidebarFileSchema.safeParse(parsed)
  if (result.success) return {}
  return { error: `sidebar.json validation failed:\n${result.error.issues.map((i) => `  - ${i.message}`).join('\n')}` }
}

function isRefusal(error: unknown): error is XAgentError {
  return error instanceof XAgentError && error.status >= 400 && error.status < 500
}

function sameFile(a: string, b: string): boolean {
  try {
    return isDeepStrictEqual(JSON.parse(a), JSON.parse(b))
  } catch {
    return false
  }
}

async function removeCopy(): Promise<void> {
  await fs.promises.rm(SIDEBAR_PATH, { force: true })
}
