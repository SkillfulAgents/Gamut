import type { Context, MiddlewareHandler } from 'hono'
import { getConnInfo } from '@hono/node-server/conninfo'
import { isAuthMode } from '@shared/lib/auth/mode'

/** The socket source addresses that are this machine: IPv4 and IPv6 loopback, and IPv4 loopback mapped into IPv6. */
export const LOCALHOST_ADDRS: ReadonlySet<string> = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/**
 * Whether this server restricts requests by their source address: the desktop
 * app without auth mode (Electron main hosts the API, bound to 0.0.0.0 for the
 * agents' containers). Docker and web deployments leave reach to their
 * infrastructure, where every request arrives from a non-loopback source.
 * `/api/*` (`LocalModeAuth`) and `/mcp` (its reach setting) both ask this.
 */
export function checksLoopbackSource(): boolean {
  return !isAuthMode() && process.type === 'browser'
}

/**
 * Whether the request's TCP peer is this machine, read from the socket. Never
 * from X-Forwarded-For or any header: a header is whatever the sender wrote.
 * Only called where `checksLoopbackSource()` holds, so on @hono/node-server.
 */
export function isLoopbackSource(c: Context): boolean {
  const addr = getConnInfo(c).remote.address
  return !!addr && LOCALHOST_ADDRS.has(addr)
}

/**
 * API path prefixes hit by the agent container, NOT a browser. These
 * authenticate via per-agent bearer tokens (IsAgent() / proxy token), so they
 * must bypass the localhost IP restriction below.
 *
 * Why the bypass is required (not just an optimization): the container reaches
 * the host across its runtime's network bridge, so the host server (bound to
 * 0.0.0.0) sees a NON-loopback source — e.g. WSL2's `172.x` NAT gateway or
 * Docker's bridge IP. Runtimes that SNAT host traffic to loopback (macOS Lima)
 * happen to pass the check, which is exactly why an omission here is invisible
 * on a dev's Mac yet 403s every cross-agent call on Windows/WSL2.
 *
 * Keep this in sync with the container-facing routers mounted in api/index.ts.
 */
const CONTAINER_FACING_PREFIXES = [
  '/api/proxy/',
  '/api/agent-bootstrap/',
  '/api/mcp-proxy/',
  '/api/x-agent/', // covers /api/x-agent and /api/x-agent/chat
  '/api/web-search/',
  '/api/web-fetch/',
  '/api/browser/',
  '/api/llm-runtime/',
  '/api/volumes/',
]

/**
 * True when `path` is a container→host endpoint that authenticates via a
 * bearer token rather than the localhost IP restriction.
 */
export function isContainerFacingPath(path: string): boolean {
  return CONTAINER_FACING_PREFIXES.some((prefix) => path.startsWith(prefix))
}

export function LocalModeAuth(): MiddlewareHandler {
  return async (c, next) => {
    // Only restrict to localhost in Electron — Docker/web deployments
    // handle network security at the infrastructure level.
    if (!checksLoopbackSource()) return next()

    if (!isLoopbackSource(c)) {
      return c.json({ error: 'Forbidden' }, 403)
    }

    return next()
  }
}
