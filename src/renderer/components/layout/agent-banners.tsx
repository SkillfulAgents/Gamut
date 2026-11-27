import { useEffect, useState } from 'react'
import { Loader2, AlertCircle, AlertTriangle, RefreshCw, X } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { useUser } from '@renderer/context/user-context'
import { useAgent, type useStartAgent } from '@renderer/hooks/use-agents'
import { useRestartAgent } from '@renderer/hooks/use-mounts'
import { useRuntimeStatus } from '@renderer/hooks/use-runtime-status'
import { driveProblemLine } from './drive-problem-line'

interface AgentBannersProps {
  slug: string
  startAgent: ReturnType<typeof useStartAgent>
}

/**
 * Agent-level banners (image pull progress, start error, health warnings,
 * missing mounts) rendered by the shared AgentShell layout above the `<Outlet/>`,
 * so they appear on every agent sub-view exactly as they did when the agent body
 * owned them. `startAgent` is shared with AgentHeader's start button so the error
 * banner reflects that exact mutation.
 */
export function AgentBanners({ slug, startAgent }: AgentBannersProps) {
  const { data: agent } = useAgent(slug)
  const { canUseAgent } = useUser()
  const restartAgent = useRestartAgent()
  // A failed restart's error holds until the agent runs again by any route. A failed stop leaves it running, so its error stays.
  const running = agent?.status === 'running'
  const { reset: resetRestart } = restartAgent
  useEffect(() => { if (running) resetRestart() }, [running, resetRestart])
  const missingDrives = agent?.missingDrives ?? []
  const driveLines = missingDrives.map(driveProblemLine)
  // A dismissal holds until the list changes, or empties at a stop.
  const drivesKey = JSON.stringify(missingDrives)
  const [dismissedDrives, setDismissedDrives] = useState<string | null>(null)
  if (!missingDrives.length && dismissedDrives !== null) setDismissedDrives(null)
  const canRestart = canUseAgent(slug) && driveLines.some((line) => line.restart)
  const { data: runtimeStatus } = useRuntimeStatus()
  const readiness = runtimeStatus?.runtimeReadiness
  const progress = readiness?.pullProgress
  const showProgress =
    !!progress &&
    (readiness?.status === 'PULLING_IMAGE' || readiness?.status === 'CHECKING')

  return (
    <>
      {/* Image pull / runtime install progress */}
      {showProgress && progress && (
        <div data-top-banner className="shrink-0 border-b bg-muted/30 px-4 py-2">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            <span>
              {readiness?.status === 'PULLING_IMAGE'
                ? `Pulling agent image... ${progress.status}`
                : progress.status}
            </span>
            {progress.percent != null && (
              <span>({progress.percent}%)</span>
            )}
          </div>
          {progress.percent != null && (
            <div className="mt-1 h-1 w-full bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-primary transition-all duration-300"
                style={{ width: `${progress.percent}%` }}
              />
            </div>
          )}
        </div>
      )}

      {/* Start error banner, also for a failed restart */}
      {(startAgent.isError || restartAgent.isError) && (
        <div data-top-banner className="shrink-0 border-b bg-destructive/10 px-4 py-2">
          <div className="flex items-center gap-2 text-xs text-destructive select-text">
            <AlertCircle className="h-3 w-3 shrink-0" />
            <span>{startAgent.isError ? `Failed to start agent: ${startAgent.error.message}` : restartAgent.error?.message}</span>
          </div>
        </div>
      )}

      {/* Health warning banner */}
      {agent?.healthWarnings?.map((warning) => (
        <div
          key={warning.checkName}
          data-top-banner
          className={`shrink-0 border-b px-4 py-2 ${
            warning.status === 'critical'
              ? 'bg-destructive/10'
              : 'bg-yellow-500/10'
          }`}
        >
          <div className={`flex items-center gap-2 text-xs select-text ${
            warning.status === 'critical'
              ? 'text-destructive'
              : 'text-yellow-700 dark:text-yellow-400'
          }`}>
            <AlertTriangle className="h-3 w-3 shrink-0" />
            <span>{warning.message}</span>
          </div>
        </div>
      ))}

      {/* Drives the running agent started without */}
      {driveLines.length > 0 && dismissedDrives !== drivesKey && (
        <div data-top-banner className="shrink-0 border-b bg-yellow-500/10 px-4 py-2">
          <div className="flex items-center gap-2 text-xs text-yellow-700 dark:text-yellow-400 select-text">
            <AlertTriangle className="h-3 w-3 shrink-0" />
            <span className="flex-1">
              {[...new Set(driveLines.map((line) => line.text))].join(' ')}
            </span>
            {canRestart && (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 text-yellow-700 dark:text-yellow-400 hover:bg-yellow-500/20 hover:text-yellow-800 dark:hover:text-yellow-300"
                onClick={() => restartAgent.mutate(slug)}
                disabled={restartAgent.isPending}
              >
                <RefreshCw className={restartAgent.isPending ? 'animate-spin' : ''} />
                {restartAgent.isPending ? 'Restarting...' : 'Restart'}
              </Button>
            )}
            <button
              onClick={() => setDismissedDrives(drivesKey)}
              className="text-yellow-700 dark:text-yellow-400 hover:text-foreground transition-colors"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}
    </>
  )
}
