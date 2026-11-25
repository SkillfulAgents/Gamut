/**
 * The CIMD fetch transport: production is Better Auth's resolve-once,
 * pin-the-address Node transport, and the end-to-end seam only adds the
 * fixture hosts it names, only under `E2E_MOCK=true`.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { fetchClientMetadataResource } from '@better-auth/cimd/node'
import { cimdTransport } from './cimd-transport'

let server: Server
let fixtureUrl: string

beforeAll(async () => {
  server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ path: request.url }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  fixtureUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve))
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('production transport', () => {
  it('is Better Auth\'s pinned Node transport unless the e2e seam is on', () => {
    vi.stubEnv('E2E_MOCK', '')
    vi.stubEnv('GAMUT_E2E_CIMD_HOSTS', JSON.stringify({ 'cimd.fixture.dev': fixtureUrl }))
    expect(cimdTransport()).toBe(fetchClientMetadataResource)
    vi.stubEnv('E2E_MOCK', 'false')
    expect(cimdTransport()).toBe(fetchClientMetadataResource)
    vi.stubEnv('E2E_MOCK', 'true')
    vi.stubEnv('GAMUT_E2E_CIMD_HOSTS', '')
    expect(cimdTransport()).toBe(fetchClientMetadataResource)
  })

  it('refuses http, loopback, private and link-local targets, before or after DNS', async () => {
    for (const url of [
      'http://example.com/client.json',
      'https://127.0.0.1/client.json',
      'https://10.0.0.5/client.json',
      'https://192.168.1.1/client.json',
      'https://169.254.169.254/latest/meta-data',
      'https://[::1]/client.json',
      'https://[fd00::1]/client.json',
      // Resolves (from /etc/hosts, no network) to loopback: refused after DNS.
      'https://localhost/client.json',
    ]) {
      await expect(fetchClientMetadataResource(url), url).rejects.toThrow()
    }
  })
})

describe('the e2e seam', () => {
  it('serves only the named fixture hosts from the local server', async () => {
    vi.stubEnv('E2E_MOCK', 'true')
    vi.stubEnv('GAMUT_E2E_CIMD_HOSTS', JSON.stringify({ 'cimd.fixture.dev': fixtureUrl }))
    const transport = cimdTransport()
    const response = await transport('https://cimd.fixture.dev/clients/test.json')
    expect(await response.json()).toEqual({ path: '/clients/test.json' })
    // Plain http to the fixture name is not the fixture.
    await expect(transport('http://cimd.fixture.dev/clients/test.json')).rejects.toThrow()
    // Any other host still goes through the real checks.
    await expect(transport('https://127.0.0.1/client.json')).rejects.toThrow()
  })

  it('ignores a malformed host map', () => {
    vi.stubEnv('E2E_MOCK', 'true')
    vi.stubEnv('GAMUT_E2E_CIMD_HOSTS', '{not json')
    expect(cimdTransport()).toBe(fetchClientMetadataResource)
  })
})
