import { z } from 'zod'

/**
 * Request body schema for the Electron host-browser control routes
 * (`/api/browser/launch-host-browser`, `/stop-host-browser`, `/debug-info`).
 *
 * `agentId` is optional and, when present, must match the agent slug resolved
 * from the caller's proxy token (enforced in the route handlers — see SUP-216).
 * The effective agent acted upon is ALWAYS the token's slug, never the raw body
 * value, so a container holding one agent's token cannot drive another agent's
 * host browser.
 */
export const hostBrowserRequestSchema = z.object({
  agentId: z.string().min(1).optional(),
})

export type HostBrowserRequest = z.infer<typeof hostBrowserRequestSchema>

/**
 * Request body for `/api/browser/downloads` — a container asking which files
 * its cloud browser's session downloaded. `sessionId` is the provider's
 * session (the launch answer's): checked to be the agent's before anything is
 * read. Capped: the body is attacker-influenceable.
 */
export const hostBrowserDownloadsRequestSchema = z.object({
  agentId: z.string().min(1).optional(),
  sessionId: z.string().min(1).max(256),
})

/**
 * Request body for `/api/browser/download-file` — one of those files, by the
 * CDP download's guid (or a name the listing gave).
 */
export const hostBrowserDownloadRequestSchema = hostBrowserDownloadsRequestSchema.extend({
  guid: z.string().min(1).max(1024),
})

export type HostBrowserDownloadRequest = z.infer<typeof hostBrowserDownloadRequestSchema>

/**
 * Request body for `/api/browser/report-launch-error` — a container relaying a
 * browser-launch failure that happened on its side (after launch-host-browser
 * succeeded) so the host can report it to Sentry. Lengths are capped because
 * the body is attacker-influenceable (any container holding a valid token).
 */
export const browserLaunchErrorReportSchema = z.object({
  agentId: z.string().min(1).optional(),
  stage: z.string().min(1).max(64),
  message: z.string().min(1).max(4000),
})

export type BrowserLaunchErrorReport = z.infer<typeof browserLaunchErrorReportSchema>
