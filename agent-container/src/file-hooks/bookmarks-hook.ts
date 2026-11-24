import { FileHook, type FileHookReadResult, type FileHookWriteResult } from './file-hook'
import { bookmarksSchema } from './bookmarks-schema'

const BOOKMARKS_PATH = '/workspace/bookmarks.json'
const MAX_RECOMMENDED_BOOKMARKS = 5

const READ_HINT = `This is the agent's pins file. Each entry is shown to the user in the "Pinned Items" panel on the agent homepage for quick access; call them pins when you talk to the user.

Format: a JSON array of objects, each with:
- "name" (string, required): Display name for the pin
- "link" (string, optional): An https:// URL (for web links)
- "file" (string, optional): A workspace file path (same paths as deliver_file, e.g. "/workspace/reports/daily.csv")
- "folder" (string, optional): A workspace folder path (e.g. "/workspace/reports")

Each pin must have exactly one of "link", "file", or "folder".

Example:
[
  { "name": "Sales Dashboard", "link": "https://docs.google.com/spreadsheets/d/abc123" },
  { "name": "Daily Report", "file": "/workspace/reports/daily-report.html" },
  { "name": "Reports", "folder": "/workspace/reports" }
]

Keep pins to important, frequently-accessed resources (max ${MAX_RECOMMENDED_BOOKMARKS} recommended). Remove pins that are no longer relevant. Anyone who can see this agent can browse a pinned folder.`

export class BookmarksFileHook extends FileHook {
  pattern(): string {
    return BOOKMARKS_PATH
  }

  matches(filePath: string): boolean {
    return filePath === BOOKMARKS_PATH
  }

  onRead(_filePath: string): FileHookReadResult {
    return { additionalContext: READ_HINT }
  }

  onWrite(_filePath: string, content: string): FileHookWriteResult {
    return this.validate(content)
  }

  onEdit(_filePath: string, contentAfterEdit: string): FileHookWriteResult {
    return this.validate(contentAfterEdit)
  }

  private validate(content: string): FileHookWriteResult {
    let parsed: unknown
    try {
      parsed = JSON.parse(content)
    } catch (e) {
      return { error: `bookmarks.json must contain valid JSON: ${(e as Error).message}` }
    }

    const result = bookmarksSchema.safeParse(parsed)
    if (!result.success) {
      const issues = result.error.issues.map(
        (i) => `  - ${i.path.join('.')}: ${i.message}`
      ).join('\n')
      return { error: `bookmarks.json validation failed:\n${issues}` }
    }

    if (result.data.length > MAX_RECOMMENDED_BOOKMARKS) {
      return {
        warning: `bookmarks.json has ${result.data.length} pins (recommended max is ${MAX_RECOMMENDED_BOOKMARKS}). Consider removing less important ones to keep the list focused.`,
      }
    }

    return {}
  }
}
