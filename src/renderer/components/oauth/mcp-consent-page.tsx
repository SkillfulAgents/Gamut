import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { apiFetch } from '@renderer/lib/api'
import { useUser } from '@renderer/context/user-context'
import { Button } from '@renderer/components/ui/button'
import { Card, CardContent, CardHeader } from '@renderer/components/ui/card'
import { Checkbox } from '@renderer/components/ui/checkbox'
import { Alert, AlertDescription } from '@renderer/components/ui/alert'
import type { ConsentClientInfo } from '@shared/lib/mcp-server/oauth/connected-clients'
import { MCP_OAUTH_SCOPES, OAUTH_SCOPE_FOR, OFFLINE_ACCESS_SCOPE } from '@shared/lib/mcp-server/oauth/oauth-config'

/**
 * `/oauth/consent`: where the MCP authorization server sends a person, signed
 * in or not (the auth gate signs them in first, SSO included, and returns them
 * here). It names the client and the host it will return to, says what each
 * permission allows in plain words, and answers the provider with the signed
 * query it was opened with (`POST /api/auth/oauth2/consent`), then follows the
 * redirect the provider gives back: the client's callback with a code, or with
 * `access_denied`.
 *
 * Everything shown about the client is text the client chose (a registered
 * name, a redirect URI); React renders it as text, never as markup or a link.
 */

const SCOPE_TEXT: Record<string, { title: string; body: string }> = {
  [OAUTH_SCOPE_FOR.read]: {
    title: 'Read',
    body: 'See your agents, their sessions and transcripts, the drives you can see, and download files from them.',
  },
  [OAUTH_SCOPE_FOR.run]: {
    title: 'Run agents',
    body: 'Start and continue sessions with your agents, and send them messages and files.',
  },
}

interface ConsentRequest {
  clientId: string
  redirectUri: string | null
  scopes: string[]
  /** The signed query, sent back as is. */
  oauthQuery: string
  expired: boolean
}

function readRequest(search: string): ConsentRequest | null {
  const params = new URLSearchParams(search)
  const clientId = params.get('client_id')
  if (!clientId || !params.get('sig')) return null
  const exp = Number(params.get('exp'))
  return {
    clientId,
    redirectUri: params.get('redirect_uri'),
    scopes: (params.get('scope') ?? '').split(' ').filter(Boolean),
    oauthQuery: search.replace(/^\?/, ''),
    expired: Number.isFinite(exp) && exp > 0 && exp * 1000 < Date.now(),
  }
}

async function readClient(request: ConsentRequest): Promise<ConsentClientInfo> {
  const query = new URLSearchParams({ client_id: request.clientId, ...(request.redirectUri ? { redirect_uri: request.redirectUri } : {}) })
  const response = await apiFetch(`/api/mcp-server/oauth/consent-client?${query}`)
  if (!response.ok) throw new Error(response.status === 404 ? 'unknown' : 'failed')
  return response.json()
}

/** The provider answers with where to send the browser next. */
async function answer(request: ConsentRequest, accept: boolean, scopes: string[]): Promise<string> {
  const response = await apiFetch('/api/auth/oauth2/consent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ accept, oauth_query: request.oauthQuery, ...(accept ? { scope: scopes.join(' ') } : {}) }),
  })
  const body = await response.json().catch(() => null) as { url?: unknown; error_description?: unknown; message?: unknown } | null
  if (!response.ok || typeof body?.url !== 'string') {
    throw new Error(typeof body?.error_description === 'string' ? body.error_description : 'Gamut could not finish connecting. Start again from the app.')
  }
  return body.url
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-8" data-testid="mcp-consent-page">
      <Card className="w-full max-w-md">{children}</Card>
    </div>
  )
}

function Problem({ title, body }: { title: string; body: string }) {
  return (
    <Shell>
      <CardHeader className="text-center"><h1 className="text-lg font-medium">{title}</h1></CardHeader>
      <CardContent><p className="text-center text-sm text-muted-foreground" data-testid="mcp-consent-problem">{body}</p></CardContent>
    </Shell>
  )
}

export function McpConsentPage() {
  const { user } = useUser()
  const request = useMemo(() => readRequest(window.location.search), [])
  const { data: client, error, isLoading } = useQuery({
    queryKey: ['mcp-consent-client', request?.clientId, request?.redirectUri],
    queryFn: () => readClient(request!),
    enabled: !!request && !request.expired,
    retry: false,
  })
  const requested = useMemo(() => (request?.scopes ?? []).filter((scope) => (MCP_OAUTH_SCOPES as readonly string[]).includes(scope)), [request])
  const [allowRun, setAllowRun] = useState(true)
  const [submitting, setSubmitting] = useState<'allow' | 'deny' | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)

  if (!request) return <Problem title="Nothing to approve" body="This page is opened by an app asking to connect to Gamut. Start the connection again from that app." />
  if (request.expired) return <Problem title="This request expired" body="Requests to connect last ten minutes. Start the connection again from the app." />
  if (isLoading) {
    return (
      <Shell>
        <CardContent className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground" role="status">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </CardContent>
      </Shell>
    )
  }
  if (error || !client) return <Problem title="Unknown app" body="Gamut does not know the app that sent you here. Start the connection again from the app." />

  const runRequested = requested.includes(OAUTH_SCOPE_FOR.run)
  const granted = [OAUTH_SCOPE_FOR.read, ...(runRequested && allowRun ? [OAUTH_SCOPE_FOR.run] : []), OFFLINE_ACCESS_SCOPE]
  const destination = client.redirectHost ?? 'an address it registered'

  const submit = async (accept: boolean) => {
    setSubmitting(accept ? 'allow' : 'deny')
    setSubmitError(null)
    try {
      window.location.assign(await answer(request, accept, granted))
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Gamut could not finish connecting.')
      setSubmitting(null)
    }
  }

  return (
    <Shell>
      <CardHeader className="space-y-3 pb-3">
        <p className="text-xs text-muted-foreground">Gamut</p>
        <h1 className="text-lg font-medium leading-snug" data-testid="mcp-consent-title">
          Allow <span className="break-words font-semibold" data-testid="mcp-consent-client-name">{client.name}</span> to use your Gamut account?
        </h1>
        <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs leading-relaxed" data-testid="mcp-consent-client-facts">
          <div>
            Returns to <span className="font-mono font-medium text-foreground" data-testid="mcp-consent-redirect-host">{destination}</span>
          </div>
          <div className="mt-1 text-muted-foreground" data-testid="mcp-consent-verification">
            {client.registration === 'metadata-document'
              ? <>The app is described by a document on <span className="font-mono text-foreground">{client.documentHost}</span>. Only approve if you trust that site.</>
              : <>Gamut cannot verify this app: the name is what the app calls itself. Only approve if you started this connection just now.</>}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-3" data-testid="mcp-consent-scopes">
          <div className="flex gap-3">
            <Checkbox id="scope-read" checked disabled aria-describedby="scope-read-body" />
            <div>
              <label htmlFor="scope-read" className="text-sm font-medium">{SCOPE_TEXT[OAUTH_SCOPE_FOR.read].title}</label>
              <p id="scope-read-body" className="text-xs text-muted-foreground">{SCOPE_TEXT[OAUTH_SCOPE_FOR.read].body}</p>
            </div>
          </div>
          {runRequested && (
            <div className="flex gap-3">
              <Checkbox
                id="scope-run"
                checked={allowRun}
                onCheckedChange={(checked) => setAllowRun(checked === true)}
                aria-describedby="scope-run-body"
                data-testid="mcp-consent-scope-run"
              />
              <div>
                <label htmlFor="scope-run" className="text-sm font-medium">{SCOPE_TEXT[OAUTH_SCOPE_FOR.run].title}</label>
                <p id="scope-run-body" className="text-xs text-muted-foreground">{SCOPE_TEXT[OAUTH_SCOPE_FOR.run].body}</p>
              </div>
            </div>
          )}
        </div>
        {runRequested && allowRun && (
          <Alert data-testid="mcp-consent-run-warning">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription className="text-xs leading-relaxed">
              Running agents lets this app make your agents act with the accounts connected to them, such as email,
              calendars and files, as you.
            </AlertDescription>
          </Alert>
        )}
        <p className="text-xs text-muted-foreground">
          {user?.email ? <>Signed in as <span className="text-foreground">{user.email}</span>. </> : null}
          It stays connected until you disconnect it in Settings → MCP Server.
        </p>
        {submitError && (
          <Alert variant="destructive" data-testid="mcp-consent-error"><AlertDescription>{submitError}</AlertDescription></Alert>
        )}
        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" disabled={submitting !== null} loading={submitting === 'deny'} onClick={() => submit(false)} data-testid="mcp-consent-deny">
            Deny
          </Button>
          <Button className="flex-1" disabled={submitting !== null} loading={submitting === 'allow'} onClick={() => submit(true)} data-testid="mcp-consent-allow">
            Allow
          </Button>
        </div>
      </CardContent>
    </Shell>
  )
}
