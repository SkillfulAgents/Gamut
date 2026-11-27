/**
 * The parts of Browserbase's REST answers (https://api.browserbase.com/v1)
 * the downloads read takes. Loose: Browserbase adds fields freely.
 */
import { z } from 'zod'

/** A session (`GET /v1/sessions/{id}`): its `contextId` stays after the session ends. */
export const browserbaseSessionSchema = z.object({
  id: z.string().min(1),
  status: z.string(),
  contextId: z.string().nullish(),
}).loose()

/** One stored download (`GET /v1/downloads?sessionId=…`): `filename` is the CDP download guid. */
export const browserbaseDownloadSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().nullish(),
  filename: z.string(),
  size: z.number().nullish(),
}).loose()
export type BrowserbaseDownload = z.infer<typeof browserbaseDownloadSchema>

export const browserbaseDownloadListSchema = z.object({
  downloads: z.array(browserbaseDownloadSchema),
  total: z.number().nullish(),
}).loose()
