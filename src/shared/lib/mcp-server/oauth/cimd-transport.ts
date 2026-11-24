/**
 * How the server fetches a Client ID Metadata Document: Better Auth's Node
 * transport (`@better-auth/cimd/node`), which resolves the host once, refuses
 * the fetch unless every address is public (no loopback, private, link-local,
 * cloud-metadata or other special-use range), connects only to the address
 * it checked (no DNS-rebinding window between check and connect), never
 * follows a redirect, and is https only. The CIMD plugin around it adds a
 * 5-second timeout, a 5 KB body limit, per-origin and global fetch budgets and
 * a refusal of any `client_id` URL that is not https on a public host.
 *
 * The repo's `url-safety.ts` validates then fetches, which leaves the rebinding
 * window; it is not used here.
 *
 * End-to-end test seam: with `E2E_MOCK=true` (never set on a deployment, the
 * same switch the mock suites already use) and `GAMUT_E2E_CIMD_HOSTS` naming
 * hosts, a document on exactly one of those hosts is fetched from the local
 * fixture server mapped to it, so the suite can register a client by CIMD
 * without a public https host. Every other host goes through the real
 * transport, so the seam adds hosts; it never relaxes the checks for others.
 */
import { z } from 'zod'
import type { ClientMetadataResourceFetch } from '@better-auth/oauth-provider'
import { fetchClientMetadataResource } from '@better-auth/cimd/node'

const fixtureHostsSchema = z.record(z.string().min(1), z.string().url())

function e2eFixtureHosts(): Record<string, string> | null {
  if (process.env.E2E_MOCK !== 'true') return null
  const raw = process.env.GAMUT_E2E_CIMD_HOSTS
  if (!raw) return null
  try {
    return fixtureHostsSchema.parse(JSON.parse(raw))
  } catch {
    return null
  }
}

export function cimdTransport(): ClientMetadataResourceFetch {
  const fixtures = e2eFixtureHosts()
  if (!fixtures) return fetchClientMetadataResource
  return async (input, init) => {
    const request = new Request(input, init)
    // eslint-disable-next-line local-rules/no-unhandled-throwing-builtins -- a Request's URL always parses
    const url = new URL(request.url)
    const fixture = url.protocol === 'https:' ? fixtures[url.host] : undefined
    if (!fixture) return fetchClientMetadataResource(input, init)
    // eslint-disable-next-line local-rules/no-unhandled-throwing-builtins -- validated by the schema above
    const target = new URL(`${url.pathname}${url.search}`, fixture)
    return fetch(target, { method: request.method, headers: request.headers, redirect: 'manual', signal: init?.signal ?? request.signal })
  }
}
