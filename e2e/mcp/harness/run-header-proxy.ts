/**
 * Runs the header proxy on its own, for running a tool (the conformance
 * suite, an inspector) by hand against a local server:
 *
 *   npx tsx e2e/mcp/harness/run-header-proxy.ts http://localhost:3014 <token>
 *
 * prints the proxy origin; `<origin>/mcp` then reaches the server's /mcp with
 * the token added.
 */
import { startHeaderProxy } from './header-proxy'

const [target, token] = process.argv.slice(2)
if (!target || !token) {
  console.error('usage: run-header-proxy.ts <server origin> <installation token>')
  process.exit(2)
}
void startHeaderProxy(target, { Authorization: `Bearer ${token}` }).then((proxy) => console.log(proxy.origin))
