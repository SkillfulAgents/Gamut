/**
 * The drive tools: list the drives the person can see, one folder level of a
 * drive, and one file. Every call goes through the volume service with the
 * same visibility the drive routes apply (`selectableVolumes`: public drives
 * and the person's own), so a private drive of someone else is "not found".
 */
import { z } from 'zod'
import { volumeBrowseSchema } from '@shared/lib/volumes/volume-browser-schema'
import { listVolumeDefinitions, openVolumeDefinition } from '@shared/lib/services/volume-service'
import type { BaseMountableVolume } from '@shared/lib/volumes/base-mountable-volume'
import { mintSignedDownloadUrl } from '@shared/lib/signed-file-urls/signed-file-urls'
import { guessMimeType } from '@shared/lib/utils/mime'
import { DEADLINE, raceDeadline } from '@shared/lib/utils/race-deadline'
import { VOLUME_TYPES } from '@shared/lib/types/mount'
import { volumeViewerFor, type McpCallContext } from '../context'
import { defineTool, READ_ONLY_ANNOTATIONS } from '../tool-definition'
import { countFitting, MAX_RESULT_CHARS, McpToolError, truncateText } from '../tool-result'

/** How much of a drive's root INDEX.md list_drives carries. */
const INDEX_MD_MAX_CHARS = 8_000
/** A drive whose INDEX.md takes longer than this is listed without it. */
const INDEX_MD_TIMEOUT_MS = 5_000
/** Drives per list_drives page. */
const DRIVES_PAGE_SIZE = 20
/** Entries per list_drive_files page (and its most). */
const ENTRIES_PAGE_SIZE = 200
const ENTRIES_MAX_PAGE_SIZE = 500
/** The largest file read_drive_file returns inline; anything larger gets a download URL. */
export const MAX_INLINE_TEXT_BYTES = 4 * 1024 * 1024
const DEFAULT_LINE_LIMIT = 1_000
const MAX_LINE_LIMIT = 5_000
/** Characters of file text one read_drive_file result carries. */
const TEXT_PAGE_MAX_CHARS = MAX_RESULT_CHARS - 2_000

const offsetSchema = z.number().int().min(0).optional().describe('Where to continue: the next_offset of the previous call. Default 0.')

/** A drive-relative path, the rule the drive browser applies; a trailing "/" is ignored. */
const drivePathSchema = z.string().max(4096)
  .transform((path) => path.replace(/\/+$/, ''))
  .pipe(volumeBrowseSchema.shape.path.unwrap())

const driveRefSchema = z.string().min(1).max(256).describe('The drive id from list_drives (a drive name is accepted when it is unique).')

function invalidPath(): McpToolError {
  return new McpToolError('Invalid path: give a path relative to the drive root, like "notes/2026.md", with no "..", no leading "/" and no backslashes. Use "" for the root.')
}

function parsePath(raw: string | undefined): string {
  const parsed = drivePathSchema.safeParse(raw ?? '')
  if (!parsed.success) throw invalidPath()
  return parsed.data
}

/** The drive's id, from an id or a unique name among the drives the person sees. */
async function resolveDriveId(ctx: McpCallContext, ref: string): Promise<{ id: string; name: string }> {
  const drives = await listVolumeDefinitions(volumeViewerFor(ctx))
  const byId = drives.find((drive) => drive.id === ref)
  if (byId) return { id: byId.id, name: byId.name }
  const byName = drives.filter((drive) => drive.name.toLowerCase() === ref.toLowerCase())
  if (byName.length === 1) return { id: byName[0].id, name: byName[0].name }
  if (byName.length > 1) throw new McpToolError(`More than one drive is named "${ref}". Pass its id from list_drives.`)
  throw new McpToolError(`Drive "${ref}" not found, or you cannot see it. Call list_drives for the drives you can read.`)
}

export async function readAll(volume: BaseMountableVolume<unknown>, path: string, maxBytes: number): Promise<{ size: number; bytes: Uint8Array | null }> {
  const file = await volume.read(path)
  if (file.size > maxBytes) {
    await file.close()
    return { size: file.size, bytes: null }
  }
  // The VolumeFile contract: `stream` once, and the stream releases the open
  // when it ends (read to the end, cancelled, or errored); `close` only when no
  // stream is taken. So the one path that must close is a stream that never
  // came (a remote source failing to start it).
  let body: ReadableStream<Uint8Array>
  try {
    body = await file.stream()
  } catch (error) {
    await file.close().catch(() => {})
    throw error
  }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      // A source whose size was wrong: stop at the bound instead of buffering it all.
      await reader.cancel().catch(() => {})
      return { size: total, bytes: null }
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    bytes.set(chunk, at)
    at += chunk.byteLength
  }
  return { size: total, bytes }
}

/** UTF-8 text without NUL bytes, or null for anything else. */
export function decodeText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

/** A drive's root INDEX.md, cut to a size a listing can carry; null when it has none or it cannot be read now. */
async function readIndexMd(ctx: McpCallContext, driveId: string): Promise<{ text: string; truncated: boolean } | null> {
  const read = (async () => {
    const volume = await openVolumeDefinition(driveId, volumeViewerFor(ctx))
    const entries = await volume.list('')
    const index = entries.find((entry) => entry.kind === 'file' && entry.name === 'INDEX.md')
      ?? entries.find((entry) => entry.kind === 'file' && entry.name.toLowerCase() === 'index.md')
    if (!index) return null
    const { bytes } = await readAll(volume, index.name, MAX_INLINE_TEXT_BYTES)
    const text = bytes ? decodeText(bytes) : null
    return text === null ? null : truncateText(text, INDEX_MD_MAX_CHARS)
  })()
  read.catch(() => {})
  try {
    // The read keeps its own rejection handler (above): a late failure is dropped.
    const result = await raceDeadline(read, Date.now() + INDEX_MD_TIMEOUT_MS)
    return result === DEADLINE ? null : result
  } catch {
    return null
  }
}

const driveSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(VOLUME_TYPES),
  team_brain: z.boolean(),
  health: z.enum(['ok', 'preparing', 'missing']),
  index_md: z.string().nullable().describe('The drive\'s root INDEX.md, when it has one.'),
  index_md_truncated: z.boolean(),
})

export const listDrives = defineTool({
  name: 'list_drives',
  title: 'List drives',
  description: 'The drives you can see in Gamut (shared folders agents work in): id, name, type, whether it is the Team Brain drive, and its root INDEX.md when it has one. Start here for team knowledge: read the Team Brain drive\'s INDEX.md first.',
  scope: 'read',
  input: z.object({ offset: offsetSchema }),
  output: z.object({
    drives: z.array(driveSchema),
    total: z.number().int(),
    next_offset: z.number().int().nullable(),
  }),
  annotations: READ_ONLY_ANNOTATIONS,
  async handler({ offset = 0 }, ctx) {
    const all = await listVolumeDefinitions(volumeViewerFor(ctx))
    // The Team Brain drive first: it is where an agent should look first.
    const ordered = [...all].sort((a, b) => Number(!!b.teamBrainDrive) - Number(!!a.teamBrainDrive))
    const page = ordered.slice(offset, offset + DRIVES_PAGE_SIZE)
    const drives = await Promise.all(page.map(async (drive) => {
      const index = drive.health === 'ok' ? await readIndexMd(ctx, drive.id) : null
      return {
        id: drive.id,
        name: drive.name,
        type: drive.type,
        team_brain: drive.teamBrainDrive === true,
        health: drive.health,
        index_md: index?.text ?? null,
        index_md_truncated: index?.truncated ?? false,
      }
    }))
    const fitting = countFitting(drives, MAX_RESULT_CHARS - 1_000)
    const end = offset + fitting
    return { drives: drives.slice(0, fitting), total: ordered.length, next_offset: end < ordered.length ? end : null }
  },
})

const entrySchema = z.object({
  name: z.string(),
  path: z.string(),
  type: z.enum(['file', 'directory']),
  size_bytes: z.number().int().nullable(),
  modified_at: z.string().nullable(),
})

export const listDriveFiles = defineTool({
  name: 'list_drive_files',
  title: 'List a drive folder',
  description: 'One folder level of a drive: its folders first, then its files, with sizes and modification times. Pass path "" for the root. To go deeper, call again with an entry\'s path.',
  scope: 'read',
  input: z.object({
    drive: driveRefSchema,
    path: z.string().max(4096).optional().describe('Folder path relative to the drive root; "" or omitted for the root.'),
    offset: offsetSchema,
    limit: z.number().int().min(1).max(ENTRIES_MAX_PAGE_SIZE).optional().describe(`Entries per page, default ${ENTRIES_PAGE_SIZE}.`),
  }),
  output: z.object({
    drive: z.object({ id: z.string(), name: z.string() }),
    path: z.string(),
    entries: z.array(entrySchema),
    total: z.number().int(),
    next_offset: z.number().int().nullable(),
  }),
  annotations: READ_ONLY_ANNOTATIONS,
  async handler({ drive: ref, path: rawPath, offset = 0, limit = ENTRIES_PAGE_SIZE }, ctx) {
    const path = parsePath(rawPath)
    const drive = await resolveDriveId(ctx, ref)
    const volume = await openVolumeDefinition(drive.id, volumeViewerFor(ctx))
    const listed = (await volume.list(path))
      .filter((entry) => entry.kind === 'file' || entry.kind === 'directory')
      .sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name))
      .map((entry) => ({
        name: entry.name,
        path: path ? `${path}/${entry.name}` : entry.name,
        type: entry.kind as 'file' | 'directory',
        size_bytes: entry.kind === 'file' && Number.isFinite(entry.size) ? entry.size : null,
        modified_at: Number.isFinite(entry.mtimeMs) && entry.mtimeMs > 0 ? new Date(entry.mtimeMs).toISOString() : null,
      }))
    const page = listed.slice(offset, offset + limit)
    const fitting = countFitting(page, MAX_RESULT_CHARS - 1_000)
    const end = offset + fitting
    return { drive, path, entries: page.slice(0, fitting), total: listed.length, next_offset: end < listed.length ? end : null }
  },
})

/** Lines `offset..` of `text`, as many as fit `limit` and the character budget. */
export function pageLines(text: string, offset: number, limit: number, maxChars: number) {
  const lines = text.split(/\r?\n/)
  // A file ending in a newline has no empty last line.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  const totalLines = lines.length
  const out: string[] = []
  let used = 0
  let truncatedLine = false
  let index = offset
  for (; index < totalLines && out.length < limit; index++) {
    const line = lines[index]
    if (used + line.length + 1 > maxChars) {
      if (out.length === 0) {
        // One line longer than the whole budget: return its start, and move past it.
        out.push(truncateText(line, maxChars).text)
        truncatedLine = true
        index++
      }
      break
    }
    out.push(line)
    used += line.length + 1
  }
  return {
    content: out.join('\n'),
    linesReturned: out.length,
    totalLines,
    nextOffset: index < totalLines ? index : null,
    truncatedLine,
  }
}

export const readDriveFile = defineTool({
  name: 'read_drive_file',
  title: 'Read a drive file',
  description: 'Read one file of a drive. A text file comes back inline, a page of lines at a time (offset = first line, 0-based; limit = lines; follow next_offset). Any other file (PDF, image, archive, or text over 4 MB) comes back as download_url, a signed link that works for a few minutes: fetch it with an HTTP GET.',
  scope: 'read',
  input: z.object({
    drive: driveRefSchema,
    path: z.string().min(1).max(4096).describe('File path relative to the drive root, like "notes/2026.md".'),
    offset: offsetSchema,
    limit: z.number().int().min(1).max(MAX_LINE_LIMIT).optional().describe(`Lines to return, default ${DEFAULT_LINE_LIMIT}.`),
  }),
  output: z.object({
    drive: z.object({ id: z.string(), name: z.string() }),
    path: z.string(),
    kind: z.enum(['text', 'download']),
    size_bytes: z.number().int(),
    mime_type: z.string(),
    content: z.string().optional(),
    offset: z.number().int().optional(),
    lines_returned: z.number().int().optional(),
    total_lines: z.number().int().optional(),
    next_offset: z.number().int().nullable().optional(),
    download_url: z.string().optional(),
    expires_at: z.string().optional(),
    note: z.string().optional(),
  }),
  annotations: READ_ONLY_ANNOTATIONS,
  async handler({ drive: ref, path: rawPath, offset = 0, limit = DEFAULT_LINE_LIMIT }, ctx) {
    const path = parsePath(rawPath)
    if (!path) throw new McpToolError('That is the drive root, a folder. Call list_drive_files to list it, and pass a file path here.')
    const drive = await resolveDriveId(ctx, ref)
    const volume = await openVolumeDefinition(drive.id, volumeViewerFor(ctx))
    const name = path.slice(path.lastIndexOf('/') + 1)
    const mimeType = guessMimeType(name)
    const { size, bytes } = await readAll(volume, path, MAX_INLINE_TEXT_BYTES)
    const text = bytes ? decodeText(bytes) : null
    if (text !== null) {
      const page = pageLines(text, offset, limit, TEXT_PAGE_MAX_CHARS)
      if (offset > 0 && offset >= page.totalLines) {
        throw new McpToolError(`offset ${offset} is past the end of the file (${page.totalLines} lines).`)
      }
      return {
        drive,
        path,
        kind: 'text' as const,
        size_bytes: size,
        mime_type: mimeType,
        content: page.content,
        offset,
        lines_returned: page.linesReturned,
        total_lines: page.totalLines,
        next_offset: page.nextOffset,
        ...(page.truncatedLine ? { note: 'A line longer than one page was cut short.' } : {}),
      }
    }
    // At the origin this client reached /mcp at, which it can certainly reach again.
    const signed = await mintSignedDownloadUrl(ctx.userId, { kind: 'drive-file', volumeId: drive.id, path }, { baseUrl: ctx.publicBaseUrl })
    return {
      drive,
      path,
      kind: 'download' as const,
      size_bytes: size,
      mime_type: mimeType,
      download_url: signed.url,
      expires_at: signed.expiresAt.toISOString(),
      note: bytes ? 'Not a text file: download it from download_url.' : 'Larger than the 4 MB read inline: download it from download_url.',
    }
  },
})

export const driveTools = [listDrives, listDriveFiles, readDriveFile] as const
