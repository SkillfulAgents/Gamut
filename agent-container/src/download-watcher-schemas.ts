import { z } from 'zod'

/** `Browser.downloadWillBegin`: sent to a session that set the download behaviour with events on. */
export const downloadWillBeginSchema = z.object({
  guid: z.string().min(1),
  url: z.string(),
  suggestedFilename: z.string(),
  frameId: z.string().optional(),
}).loose()

/** `Browser.downloadProgress`. */
export const downloadProgressSchema = z.object({
  guid: z.string().min(1),
  state: z.enum(['inProgress', 'completed', 'canceled']),
  /** Where the browser saved it, on its own machine: set on `completed`. */
  filePath: z.string().optional(),
}).loose()

/** The host's error body on `/api/browser/downloads` and `/api/browser/download-file`. */
export const hostDownloadErrorSchema = z.object({ error: z.string() }).loose()

/** The host's answer on `/api/browser/downloads`: the session's stored files. */
export const hostDownloadListSchema = z.object({
  files: z.array(z.object({ name: z.string().min(1), size: z.number().nullable() }).loose()),
}).loose()
