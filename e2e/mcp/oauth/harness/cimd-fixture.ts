/**
 * Serves Client ID Metadata Documents for `https://cimd.gamut-e2e.dev/<name>.json`.
 * The server under test fetches that host from here (GAMUT_E2E_CIMD_HOSTS,
 * honoured only with E2E_MOCK=true); every other host goes through the real,
 * address-pinned transport. Records each fetch, so a test can see the server
 * actually read the document.
 */
import * as http from 'node:http'
import { CIMD_HOST, cimdFixturePort } from './oauth-app'

export interface CimdFixture {
  /** The `client_id` (and document URL) for a document name. */
  clientIdFor(name: string): string
  serve(name: string, document: Record<string, unknown>): string
  fetched: string[]
  close(): Promise<void>
}

export async function startCimdFixture(): Promise<CimdFixture> {
  const documents = new Map<string, Record<string, unknown>>()
  const fetched: string[] = []
  const server = http.createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0]
    fetched.push(path)
    const document = documents.get(path)
    if (!document) {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end('{"error":"not found"}')
      return
    }
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'max-age=60' })
    response.end(JSON.stringify(document))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(cimdFixturePort(), '127.0.0.1', () => resolve())
  })
  const clientIdFor = (name: string) => `https://${CIMD_HOST}/${name}.json`
  return {
    clientIdFor,
    serve(name, document) {
      const clientId = clientIdFor(name)
      documents.set(`/${name}.json`, { client_id: clientId, ...document })
      return clientId
    },
    fetched,
    close: () => new Promise((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
}
