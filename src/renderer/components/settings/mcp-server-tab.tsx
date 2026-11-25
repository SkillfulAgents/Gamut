import { useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Copy, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { apiFetch } from '@renderer/lib/api'
import { copyTextToClipboard } from '@renderer/lib/clipboard'
import { useUser } from '@renderer/context/user-context'
import { mcpServerRunsOnThisComputer, offersMcpReachChoice } from '@renderer/lib/capabilities'
import { Button } from '@renderer/components/ui/button'
import { Switch } from '@renderer/components/ui/switch'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@renderer/components/ui/alert-dialog'
import { mcpClientSetups, mcpOAuthClientSetups, type McpClientSetup } from '@shared/lib/mcp-server/client-setup'
import type { McpServerReach, McpServerStatusResponse } from '@shared/lib/mcp-server/mcp-server-settings-schema'
import type { ConnectedMcpClient } from '@shared/lib/mcp-server/oauth/connected-clients'
import { cn } from '@shared/lib/utils'
import { SETTINGS_CARD_CLASS, SETTINGS_SECTION_HEADING } from './setting-row'

const CARD_CLASS = SETTINGS_CARD_CLASS
const SECTION_HEADING = SETTINGS_SECTION_HEADING
const QUERY_KEY = ['mcp-server'] as const
const CLIENTS_QUERY_KEY = ['mcp-server', 'oauth-clients'] as const

const REACH_OPTIONS: Array<{ value: McpServerReach; label: string }> = [
  { value: 'this-computer', label: 'This computer only' },
  { value: 'network', label: 'Other devices on your network' },
]

/** The endpoint's port, as other devices must use it too. */
function portOf(url: string): string {
  try {
    return new URL(url).port
  } catch {
    return ''
  }
}

async function readStatus(): Promise<McpServerStatusResponse> {
  const response = await apiFetch('/api/mcp-server')
  if (!response.ok) throw new Error('Could not load the MCP server settings')
  return response.json()
}

async function readClients(): Promise<ConnectedMcpClient[]> {
  const response = await apiFetch('/api/mcp-server/oauth/clients')
  if (!response.ok) throw new Error('Could not load your connected clients')
  return ((await response.json()) as { clients: ConnectedMcpClient[] }).clients
}

async function send<T = McpServerStatusResponse>(path: string, init: RequestInit): Promise<T> {
  const response = await apiFetch(path, init)
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null
    throw new Error(body?.error ?? 'The change did not save')
  }
  return response.json()
}

function CopyButton({ text, label, testId }: { text: string; label: string; testId: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      variant="soft"
      size="sm"
      aria-label={label}
      data-testid={testId}
      onClick={() => {
        copyTextToClipboard(text).then(
          () => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          },
          () => toast.error('Could not copy to the clipboard'),
        )
      }}
    >
      {copied ? <Check className="h-3.5 w-3.5 mr-1.5" /> : <Copy className="h-3.5 w-3.5 mr-1.5" />}
      {copied ? 'Copied' : 'Copy'}
    </Button>
  )
}

function SetupList({ setups }: { setups: McpClientSetup[] }) {
  return (
    <div className={CARD_CLASS}>
      {setups.map((setup) => (
        <div key={setup.id} className="space-y-2 px-4 py-3" data-testid={`mcp-setup-${setup.id}`}>
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-xs font-normal">{setup.label}</div>
              <div className="mt-0.5 text-[11px] text-muted-foreground">{setup.hint}</div>
            </div>
            <CopyButton text={setup.text} label={`Copy ${setup.label} setup`} testId={`mcp-setup-copy-${setup.id}`} />
          </div>
          <pre
            className="overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-muted px-3 py-2 font-mono text-[11px] leading-relaxed"
            data-testid={`mcp-setup-text-${setup.id}`}
          >
            {setup.text}
          </pre>
        </div>
      ))}
    </div>
  )
}

function useToggle() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (enabled: boolean) => send('/api/mcp-server/enabled', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    }),
    onSuccess: (next) => queryClient.setQueryData(QUERY_KEY, next),
    onError: (err) => toast.error(err instanceof Error ? err.message : 'The change did not save'),
  })
}

/** The switch and the endpoint; `children` go between them (the desktop app's reach choice). */
function ServerRows({ status, canManage, onText, offText, children }: { status: McpServerStatusResponse; canManage: boolean; onText: string; offText: string; children?: ReactNode }) {
  const toggle = useToggle()
  return (
    <>
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="min-w-0 flex-1">
          <label htmlFor="mcp-server-enabled" className="block cursor-default text-xs font-normal">MCP server</label>
          <div className="mt-0.5 text-[11px] text-muted-foreground" data-testid="mcp-server-enabled-state">
            {status.enabled ? onText : offText}
          </div>
        </div>
        <Switch
          id="mcp-server-enabled"
          checked={status.enabled}
          disabled={!canManage || toggle.isPending}
          onCheckedChange={(checked: boolean) => toggle.mutate(checked)}
          data-testid="mcp-server-enabled-switch"
        />
      </div>
      {children}
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-normal">Endpoint</div>
          <div className="mt-0.5 break-all font-mono text-[11px] text-muted-foreground" data-testid="mcp-server-endpoint">
            {status.endpointUrl}
          </div>
        </div>
        <CopyButton text={status.endpointUrl} label="Copy endpoint URL" testId="mcp-server-copy-endpoint" />
      </div>
    </>
  )
}

function formatWhen(iso: string | null): string {
  if (!iso) return 'never'
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? 'unknown' : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

const SCOPE_LABEL: Record<string, string> = { 'gamut:read': 'Read', 'gamut:run': 'Run agents' }

function ConnectedClients() {
  const queryClient = useQueryClient()
  const { data: clients, isLoading, error } = useQuery({ queryKey: CLIENTS_QUERY_KEY, queryFn: readClients })
  const revoke = useMutation({
    mutationFn: (clientId: string) => send<{ revoked: boolean }>('/api/mcp-server/oauth/clients/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId }),
    }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: CLIENTS_QUERY_KEY })
      toast.success('Disconnected. It can no longer use your account.')
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Could not disconnect'),
  })

  return (
    <div className="space-y-2">
      <h3 className={SECTION_HEADING}>Your connected clients</h3>
      <div className={CARD_CLASS} data-testid="mcp-connected-clients">
        {isLoading ? (
          <div className="px-4 py-3 text-[11px] text-muted-foreground" role="status">Loading…</div>
        ) : error || !clients ? (
          <div className="px-4 py-3 text-[11px] text-destructive">Could not load your connected clients.</div>
        ) : clients.length === 0 ? (
          <div className="px-4 py-3 text-[11px] text-muted-foreground" data-testid="mcp-connected-clients-empty">
            No clients are connected to your account.
          </div>
        ) : clients.map((client) => (
          <div key={client.clientId} className="flex items-start gap-3 px-4 py-3" data-testid="mcp-connected-client">
            <div className="min-w-0 flex-1 space-y-0.5">
              <div className="flex flex-wrap items-center gap-x-2 text-xs font-medium">
                <span className="break-words" data-testid="mcp-connected-client-name">{client.name}</span>
                <span className="text-[10px] font-normal text-muted-foreground">
                  {client.registration === 'metadata-document' ? `described by ${client.documentHost}` : 'unverified name'}
                </span>
              </div>
              <div className="text-[11px] text-muted-foreground">
                Returns to <span className="font-mono">{client.redirectHosts.join(', ') || 'unknown'}</span>
              </div>
              <div className="text-[11px] text-muted-foreground" data-testid="mcp-connected-client-scopes">
                {client.scopes.map((scope) => SCOPE_LABEL[scope] ?? scope).join(' · ') || 'No permissions'}
              </div>
              <div className="text-[11px] text-muted-foreground">
                Connected {formatWhen(client.connectedAt)} · last active {formatWhen(client.lastActiveAt)}
              </div>
            </div>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="soft" size="sm" disabled={revoke.isPending} data-testid="mcp-connected-client-revoke">
                  Disconnect
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Disconnect {client.name}?</AlertDialogTitle>
                  <AlertDialogDescription>
                    It stops working at once and must sign in again to reconnect. Sessions it started stay in Gamut.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={() => revoke.mutate(client.clientId)} data-testid="mcp-connected-client-revoke-confirm">
                    Disconnect
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Auth mode: an admin's workspace-wide switch, the endpoint, setup without a token, and the person's own clients. */
function OAuthServerSettings({ status }: { status: McpServerStatusResponse }) {
  const { isAdmin } = useUser()
  return (
    <div className="space-y-6" data-testid="mcp-server-tab">
      <p className="px-1 text-[11px] leading-relaxed text-muted-foreground" data-testid="mcp-server-intro">
        Let AI tools like Claude Code, Codex, Cursor and Claude work with this workspace&apos;s agents through MCP: read
        drives and sessions, ask the Team Brain, and run agents, sending and receiving files. Each tool signs in with
        your Gamut account and can only do what you can. A tool you let run agents makes them act with their connected
        accounts.
      </p>

      <div className="space-y-2">
        <h3 className={SECTION_HEADING}>Server</h3>
        <div className={CARD_CLASS}>
          <ServerRows
            status={status}
            canManage={isAdmin}
            onText="On for the whole workspace: members can connect their tools."
            offText={isAdmin ? 'Off for the whole workspace: the endpoint does not answer.' : 'Off: an administrator can turn it on for the workspace.'}
          />
        </div>
      </div>

      <div className="space-y-2">
        <h3 className={SECTION_HEADING}>Connect a client</h3>
        <SetupList setups={mcpOAuthClientSetups(status.endpointUrl)} />
        <p className="px-1 text-[11px] leading-relaxed text-muted-foreground" data-testid="mcp-server-reach">
          No token to copy: the first time a tool connects, your browser opens Gamut to sign in and approve it.
        </p>
      </div>

      <ConnectedClients />
    </div>
  )
}

/**
 * Settings → MCP Server: the switch for `/mcp`, where it is, and the setup to
 * paste into Claude Code, Codex or Cursor. Without auth mode the setup carries
 * the installation token; in auth mode each tool signs in (OAuth) and the page
 * lists the person's connected clients.
 */
export function McpServerTab() {
  const { isAdmin, isAuthMode } = useUser()
  const canManage = !isAuthMode || isAdmin
  const queryClient = useQueryClient()
  const { data: status, isLoading, error } = useQuery({ queryKey: QUERY_KEY, queryFn: readStatus })

  const changeReach = useMutation({
    mutationFn: (reach: McpServerReach) => send('/api/mcp-server/reach', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reach }),
    }),
    onSuccess: (next) => queryClient.setQueryData(QUERY_KEY, next),
    onError: (err) => toast.error(err instanceof Error ? err.message : 'The change did not save'),
  })

  const regenerate = useMutation({
    mutationFn: () => send('/api/mcp-server/token/regenerate', { method: 'POST' }),
    onSuccess: (next) => {
      queryClient.setQueryData(QUERY_KEY, next)
      toast.success('New token created. Update the setup in each client you use.')
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Could not create a new token'),
  })

  if (isLoading) return <div className="px-1 text-xs text-muted-foreground" role="status">Loading…</div>
  if (error || !status) return <div className="px-1 text-xs text-destructive">Could not load the MCP server settings.</div>
  if (!status.available) {
    return (
      <p className="px-1 text-xs text-muted-foreground" data-testid="mcp-server-unavailable">
        {status.unavailableReason ?? 'The MCP server is not available in this workspace.'}
      </p>
    )
  }
  if (status.auth === 'oauth') return <OAuthServerSettings status={status} />

  const setups = status.token ? mcpClientSetups(status.endpointUrl, status.token) : []
  // Where the server is decides what the page can promise about reaching it.
  const local = mcpServerRunsOnThisComputer()
  // Only the desktop app checks where a request comes from; elsewhere the network setup decides.
  const reachChoice = offersMcpReachChoice() && status.reach.applies
  const network = reachChoice && status.reach.value === 'network'
  const port = portOf(status.endpointUrl)
  const networkUrls = status.reach.networkAddresses.map((address) => `http://${address}${port ? `:${port}` : ''}/mcp`)

  return (
    <div className="space-y-6" data-testid="mcp-server-tab">
      <p className="px-1 text-[11px] leading-relaxed text-muted-foreground" data-testid="mcp-server-intro">
        {local
          ? 'Let AI tools like Claude Code, Codex and Cursor work with your Gamut agents through MCP: read your drives and sessions, ask the Team Brain, and run agents, sending and receiving files.'
          : 'Let AI tools like Claude Code, Codex and Cursor work with this workspace\'s agents through MCP: read its drives and sessions, ask the Team Brain, and run agents, sending and receiving files.'}{' '}
        They connect with the token below and can do what you can do here. A tool that runs an agent makes it act with that agent&apos;s connected accounts.
      </p>

      <div className="space-y-2">
        <h3 className={SECTION_HEADING}>Server</h3>
        <div className={CARD_CLASS}>
          <ServerRows status={status} canManage={canManage} onText="On: clients with the token can connect." offText="Off: the endpoint does not answer.">
            {reachChoice && (
              <div className="space-y-2 px-4 py-3" data-testid="mcp-server-reach-choice">
                <div className="text-xs font-normal" id="mcp-server-reach-label">Who can connect</div>
                <div role="radiogroup" aria-labelledby="mcp-server-reach-label" className="inline-flex rounded-md border p-0.5">
                  {REACH_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      role="radio"
                      aria-checked={status.reach.value === option.value}
                      disabled={!canManage || changeReach.isPending}
                      onClick={() => { if (status.reach.value !== option.value) changeReach.mutate(option.value) }}
                      className={cn(
                        'rounded px-3 py-1 text-xs transition-colors disabled:cursor-not-allowed',
                        status.reach.value === option.value ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
                      )}
                      data-testid={`mcp-server-reach-${option.value}`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  A tool in WSL, or in a container on some setups, connects as another device.
                </div>
                {network && (
                  <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed" data-testid="mcp-server-reach-warning">
                    Requests travel over plain http, so anyone on the network who can see the traffic can read the token. Use this on networks you trust.
                  </div>
                )}
              </div>
            )}
          </ServerRows>
          <div className="flex items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="text-xs font-normal">Token</div>
              <div className="mt-0.5 text-[11px] text-muted-foreground">
                Anyone with it can read and run what you can in Gamut. Regenerating it disconnects every client until you update its setup.
              </div>
            </div>
            {canManage && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="soft" size="sm" disabled={regenerate.isPending} data-testid="mcp-server-regenerate">
                    <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                    Regenerate
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Regenerate the MCP token?</AlertDialogTitle>
                    <AlertDialogDescription>
                      The current token stops working right away. Clients set up with it cannot connect until you
                      paste the new setup into them.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={() => regenerate.mutate()} data-testid="mcp-server-regenerate-confirm">
                      Regenerate
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <h3 className={SECTION_HEADING}>Connect a client</h3>
        <SetupList setups={setups} />
        <p className="px-1 text-[11px] leading-relaxed text-muted-foreground" data-testid="mcp-server-reach">
          {!local
            ? 'The address is this workspace\'s server. A tool can connect from any computer that can reach it.'
            : network
              ? <>
                  The setup above is for tools on this computer. Other devices use this computer&apos;s network address and the same port
                  {networkUrls.length > 0 ? <>, such as <span className="font-mono">{networkUrls.join(', ')}</span></> : null}. Web apps such as claude.ai cannot reach it.
                </>
              : reachChoice
                ? 'The address is this computer\'s, and only tools running on this computer can connect. Web apps such as claude.ai cannot.'
                : 'The address is this computer\'s, so tools running here can reach it. Web apps such as claude.ai cannot.'}
        </p>
      </div>
    </div>
  )
}
