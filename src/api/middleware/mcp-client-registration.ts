/**
 * Limits on open Dynamic Client Registration (`POST /api/auth/oauth2/register`,
 * RFC 7591), which anyone can call without signing in so clients without a
 * Client ID Metadata Document (Cursor) can connect.
 *
 * - Counted in AppState fixed windows, so every process serving the tenant
 *   counts together: per client address and across the workspace, each an
 *   hour long. A refused registration answers 429 with `Retry-After`.
 * - A body over 8 KB is refused before it is read; `client_name` is at most 100
 *   characters, each URI at most 2048, at most 10 redirect URIs and 5
 *   contacts. A registration is a row every later consent screen and the
 *   connected-clients list read, so its size is bounded here rather than
 *   wherever it is shown.
 *
 * What is registered stays unverified: the consent screen says the name is the
 * client's own claim and shows the redirect host it will return to.
 */
import type { MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { defineFixedWindow } from '@shared/lib/app-state/fixed-window'
import { DCR_LIMITS } from '@shared/lib/mcp-server/oauth/oauth-config'
import { rateLimitClient } from './rate-limit'

const HOUR_MS = 60 * 60_000

export const clientRegistrationsPerClient = defineFixedWindow({ name: 'rate:mcp-dcr-client', limit: DCR_LIMITS.perClientPerHour, windowMs: HOUR_MS })
export const clientRegistrationsGlobal = defineFixedWindow({ name: 'rate:mcp-dcr-global', limit: DCR_LIMITS.globalPerHour, windowMs: HOUR_MS })

const URI_FIELDS = ['client_uri', 'logo_uri', 'tos_uri', 'policy_uri', 'jwks_uri', 'software_id', 'software_version', 'backchannel_logout_uri'] as const
const URI_LIST_FIELDS = ['redirect_uris', 'post_logout_redirect_uris'] as const
const MAX_CONTACTS = 5

function invalidMetadata(description: string): Response {
  return new Response(JSON.stringify({ error: 'invalid_client_metadata', error_description: description }), {
    status: 400,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

/** Why this registration body is refused, or null. */
export function registrationFieldProblem(body: unknown): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'The registration must be a JSON object.'
  const record = body as Record<string, unknown>
  if (typeof record.client_name === 'string' && record.client_name.length > DCR_LIMITS.maxNameChars) {
    return `client_name is longer than ${DCR_LIMITS.maxNameChars} characters.`
  }
  for (const field of URI_FIELDS) {
    const value = record[field]
    if (typeof value === 'string' && value.length > DCR_LIMITS.maxUriChars) return `${field} is longer than ${DCR_LIMITS.maxUriChars} characters.`
  }
  for (const field of URI_LIST_FIELDS) {
    const value = record[field]
    if (!Array.isArray(value)) continue
    if (value.length > DCR_LIMITS.maxRedirectUris) return `${field} lists more than ${DCR_LIMITS.maxRedirectUris} URIs.`
    if (value.some((uri) => typeof uri === 'string' && uri.length > DCR_LIMITS.maxUriChars)) return `A URI in ${field} is longer than ${DCR_LIMITS.maxUriChars} characters.`
  }
  if (Array.isArray(record.contacts) && (record.contacts.length > MAX_CONTACTS || record.contacts.some((c) => typeof c === 'string' && c.length > 320))) {
    return `contacts lists more than ${MAX_CONTACTS} addresses, or one is too long.`
  }
  return null
}

/** Refuses a body over the limit as it streams in, with or without a declared length. */
export const mcpClientRegistrationBodyLimit: MiddlewareHandler = bodyLimit({
  maxSize: DCR_LIMITS.maxBodyBytes,
  onError: () => invalidMetadataTooLarge(),
})

export const mcpClientRegistrationLimits: MiddlewareHandler = async (c, next) => {
  if (c.req.method !== 'POST') return next()
  const raw = await c.req.raw.clone().arrayBuffer()

  // Counted before the body is judged: a flood of malformed registrations is still a flood.
  const perClient = await clientRegistrationsPerClient.hit(clientRegistrationsPerClient.key(rateLimitClient(c)))
  const global = perClient.admitted ? await clientRegistrationsGlobal.hit(clientRegistrationsGlobal.key('all')) : null
  const refused = !perClient.admitted ? perClient : global && !global.admitted ? global : null
  if (refused) {
    const retryAfter = Math.max(1, Math.ceil((refused.resetAt - Date.now()) / 1000))
    return c.json({ error: 'too_many_requests', error_description: 'Too many client registrations. Try again later.' }, 429, { 'Retry-After': String(retryAfter) })
  }

  let body: unknown
  try {
    body = JSON.parse(new TextDecoder().decode(raw))
  } catch {
    return invalidMetadata('The registration is not valid JSON.')
  }
  const problem = registrationFieldProblem(body)
  if (problem) return invalidMetadata(problem)
  return next()
}

function invalidMetadataTooLarge(): Response {
  return new Response(JSON.stringify({ error: 'invalid_client_metadata', error_description: `The registration is larger than ${DCR_LIMITS.maxBodyBytes} bytes.` }), {
    status: 413,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}
