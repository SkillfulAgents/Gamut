import { useState } from 'react'
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
import { mcpClientSetups } from '@shared/lib/mcp-server/client-setup'
import type { McpServerReach, McpServerStatusResponse } from '@shared/lib/mcp-server/mcp-server-settings-schema'
import { cn } from '@shared/lib/utils'

const CARD_CLASS = 'rounded-card border bg-background divide-y divide-border/50 overflow-hidden'
const SECTION_HEADING = 'text-xs font-medium text-muted-foreground px-1'
const QUERY_KEY = ['mcp-server'] as const

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

async function send(path: string, init: RequestInit): Promise<McpServerStatusResponse> {
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
      variant="outline"
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

/**
 * Settings → MCP Server: the switch for `/mcp`, where it is, and the setup to
 * paste into Claude Code, Codex or Cursor, with the installation token in it.
 */
export function McpServerTab() {
  const { isAdmin, isAuthMode } = useUser()
  const canManage = !isAuthMode || isAdmin
  const queryClient = useQueryClient()
  const { data: status, isLoading, error } = useQuery({ queryKey: QUERY_KEY, queryFn: readStatus })

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => send('/api/mcp-server/enabled', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    }),
    onSuccess: (next) => queryClient.setQueryData(QUERY_KEY, next),
    onError: (err) => toast.error(err instanceof Error ? err.message : 'The change did not save'),
  })

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
        The MCP server is not available in this workspace yet.
      </p>
    )
  }

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
          <div className="flex items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <label htmlFor="mcp-server-enabled" className="block cursor-default text-xs font-medium">MCP server</label>
              <div className="mt-0.5 text-[11px] text-muted-foreground">
                {status.enabled ? 'On: clients with the token can connect.' : 'Off: the endpoint does not answer.'}
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
          {reachChoice && (
            <div className="space-y-2 px-4 py-3" data-testid="mcp-server-reach-choice">
              <div className="text-xs font-medium" id="mcp-server-reach-label">Who can connect</div>
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
          <div className="flex items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium">Endpoint</div>
              <div className="mt-0.5 break-all font-mono text-[11px] text-muted-foreground" data-testid="mcp-server-endpoint">
                {status.endpointUrl}
              </div>
            </div>
            <CopyButton text={status.endpointUrl} label="Copy endpoint URL" testId="mcp-server-copy-endpoint" />
          </div>
          <div className="flex items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium">Token</div>
              <div className="mt-0.5 text-[11px] text-muted-foreground">
                Anyone with it can read and run what you can in Gamut. Regenerating it disconnects every client until you update its setup.
              </div>
            </div>
            {canManage && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="outline" size="sm" disabled={regenerate.isPending} data-testid="mcp-server-regenerate">
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
        <div className={CARD_CLASS}>
          {setups.map((setup) => (
            <div key={setup.id} className="space-y-2 px-4 py-3" data-testid={`mcp-setup-${setup.id}`}>
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-medium">{setup.label}</div>
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
