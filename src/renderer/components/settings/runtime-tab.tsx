import { providerEnvVarsError } from '@shared/lib/llm-provider/provider-env'
import { useState, useEffect, useMemo } from 'react'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Switch } from '@renderer/components/ui/switch'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
import { Alert, AlertDescription, AlertTitle } from '@renderer/components/ui/alert'
import {
  useSettings,
  useUpdateSettings,
  useStartRunner,
  useRestartRunner,
  useRefreshAvailability,
  isWarmStartOnTypeEnabled,
  isAutoResumeOnUnexpectedDeathEnabled,
} from '@renderer/hooks/use-settings'
import { AlertCircle, AlertTriangle, Play, Download, Loader2, RefreshCw, Plus, X } from 'lucide-react'
import { RunnerSetupErrorPanel, getRunnerSetupPayload } from '@renderer/components/settings/runner-setup-error-panel'
import { RuntimeProvisionProgress } from '@renderer/components/runtime/runtime-provision-progress'
import { DEFAULT_LIMA_VM_MEMORY, VALID_LIMA_VM_MEMORY_OPTIONS } from '@shared/lib/container/types'
import { assessVmMemory } from '@shared/lib/container/vm-memory'
import { findReservedEnvVarKeys } from '@shared/lib/container/reserved-env-vars'
import { getDefaultAgentImage } from '@shared/lib/config/version'
import { SETTINGS_CARD_CLASS, SETTINGS_SECTION_HEADING, SettingRow } from './setting-row'
import { SettingsHeaderActions } from './settings-page'
import { PresetNumberSelect } from './preset-number-select'
import { AgentImageSelect } from './agent-image-select'

function formatMinutes(minutes: number): string {
  if (minutes % 60 !== 0) return `${minutes} minutes`
  const hours = minutes / 60
  return hours === 1 ? '1 hour' : `${hours} hours`
}
const formatUsd = (usd: number) => '$' + usd

const CPU_LIMIT_OPTIONS = [1, 2, 4, 6, 8]
const MEMORY_LIMIT_OPTIONS: { value: string; label: string }[] = [
  { value: '512m', label: '512 MB' },
  { value: '1g', label: '1 GB' },
  { value: '2g', label: '2 GB' },
  { value: '4g', label: '4 GB' },
  { value: '8g', label: '8 GB' },
  { value: '16g', label: '16 GB' },
  { value: '32g', label: '32 GB' },
]

const RUNNER_LABELS: Record<string, string> = {
  'apple-container': 'macOS Container',
  docker: 'Docker',
  podman: 'Podman',
  lima: 'Built-in Runtime',
  wsl2: 'Built-in Runtime',
}

function normalizeEnvVarName(name: string): string {
  return name.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_')
}

/**
 * Per-runtime settings definitions.
 * Each runtime declares its configurable fields with metadata for rendering.
 */
interface RuntimeSettingField {
  key: string
  label: string
  description: string
  type: 'select' | 'text'
  options?: { value: string; label: string }[]
  defaultValue: string
}

const MEMORY_LABELS: Record<string, string> = {
  '2GiB': '2 GB', '4GiB': '4 GB', '6GiB': '6 GB',
  '8GiB': '8 GB', '12GiB': '12 GB', '16GiB': '16 GB',
}

const RUNTIME_SETTINGS: Record<string, RuntimeSettingField[]> = {
  lima: [
    {
      key: 'vmMemory',
      label: 'VM Memory',
      description: 'Maximum memory for the built-in runtime VM. Only used as needed.',
      type: 'select',
      options: VALID_LIMA_VM_MEMORY_OPTIONS.map((v) => ({ value: v, label: MEMORY_LABELS[v] || v })),
      defaultValue: DEFAULT_LIMA_VM_MEMORY,
    },
  ],
}

export function RuntimeTab() {
  const { data: settings, isLoading } = useSettings()
  const updateSettings = useUpdateSettings()
  const startRunner = useStartRunner()
  const restartRunner = useRestartRunner()
  const refreshAvailability = useRefreshAvailability()

  // Local form state — main settings
  const [containerRunner, setContainerRunner] = useState('')
  const [agentImage, setAgentImage] = useState('')
  const [cpuLimit, setCpuLimit] = useState('')
  const [memoryLimit, setMemoryLimit] = useState('')
  const idleMinutes = settings?.app?.autoSleepTimeoutMinutes ?? 30
  const [customEnvVarsDraft, setCustomEnvVarsDraft] = useState<Record<string, string>>({})
  const [isAddEnvDialogOpen, setIsAddEnvDialogOpen] = useState(false)
  const [newEnvName, setNewEnvName] = useState('')
  const [newEnvValue, setNewEnvValue] = useState('')
  const [customEnvError, setCustomEnvError] = useState<string | null>(null)
  const [dialogEnvError, setDialogEnvError] = useState<string | null>(null)

  // Local form state — runtime-specific settings (keyed by field key)
  const [runtimeSettingsForm, setRuntimeSettingsForm] = useState<Record<string, string>>({})

  // Track if form has unsaved changes
  const [hasChanges, setHasChanges] = useState(false)

  // Get saved runtime settings for the current runner
  const savedRuntimeSettings = useMemo(
    () => settings?.container.runtimeSettings?.[containerRunner] ?? {},
    [settings, containerRunner]
  )

  // Get the field definitions for the current runner
  const currentRunnerFields = useMemo(
    () => RUNTIME_SETTINGS[containerRunner] ?? [],
    [containerRunner]
  )

  // Sizing guardrail for the built-in runtime's VM memory: options at or above
  // the machine's physical RAM are disabled (the server refuses them too), and
  // picks above half of it get an inline warning — that configuration starves
  // the host and gets agents OOM-killed mid-turn.
  const hostTotalMemoryBytes = settings?.hostTotalMemoryBytes
  const assessVmMemoryOption = (value: string) =>
    hostTotalMemoryBytes ? assessVmMemory(value, hostTotalMemoryBytes) : ({ level: 'ok' } as const)
  const vmMemoryAssessment = useMemo(() => {
    const selected = runtimeSettingsForm.vmMemory
    if (!selected || !hostTotalMemoryBytes) return { level: 'ok' } as const
    return assessVmMemory(selected, hostTotalMemoryBytes)
  }, [runtimeSettingsForm.vmMemory, hostTotalMemoryBytes])

  // Check if runtime-specific settings have changed
  const runtimeSettingsChanged = useMemo(() => {
    return currentRunnerFields.some((field) => {
      const saved = savedRuntimeSettings[field.key] || field.defaultValue
      const current = runtimeSettingsForm[field.key] || field.defaultValue
      return saved !== current
    })
  }, [currentRunnerFields, savedRuntimeSettings, runtimeSettingsForm])

  // Compute runner availability map with detailed status
  const runnerAvailabilityMap = useMemo(() => {
    const map = new Map<string, { installed: boolean; running: boolean; available: boolean; canStart: boolean; supportsCustomAgentImage: boolean }>()
    settings?.runnerAvailability?.forEach((r) => {
      map.set(r.runner, {
        installed: r.installed,
        running: r.running,
        available: r.available,
        canStart: r.canStart,
        supportsCustomAgentImage: r.supportsCustomAgentImage ?? true,
      })
    })
    return map
  }, [settings?.runnerAvailability])

  // Runners whose image is fixed by the deployment (e.g. lambda-microvm) ignore
  // settings.container.agentImage — lock the field so edits aren't misleading.
  const agentImageLocked =
    runnerAvailabilityMap.get(containerRunner)?.supportsCustomAgentImage === false

  const noRunnersAvailable = useMemo(() => {
    if (!settings?.runnerAvailability) return false
    return settings.runnerAvailability.every((r) => !r.available)
  }, [settings?.runnerAvailability])

  // Check if any runner can be started or first-installed via startRunner
  const hasStartableRunner = useMemo(() => {
    if (!settings?.runnerAvailability) return false
    return settings.runnerAvailability.some((r) => !r.running && r.canStart)
  }, [settings?.runnerAvailability])

  // Derive runner list from server-reported availability (only shows eligible runners)
  const containerRunners = useMemo(() => {
    if (!settings?.runnerAvailability) {
      return [{ value: 'docker', label: 'Docker' }]
    }
    return settings.runnerAvailability.map((r) => ({
      value: r.runner,
      label: RUNNER_LABELS[r.runner] || r.runner,
    }))
  }, [settings?.runnerAvailability])

  // Sync each persisted field from its primitive value so availability-only
  // settings refetches do not reset an in-progress dropdown selection.
  useEffect(() => {
    if (!settings) return
    setContainerRunner(settings.container.containerRunner)
  }, [settings?.container.containerRunner])

  useEffect(() => {
    if (!settings) return
    setAgentImage(settings.container.agentImage)
    setCpuLimit(settings.container.resourceLimits.cpu.toString())
    setMemoryLimit(settings.container.resourceLimits.memory)
  }, [
    settings?.container.agentImage,
    settings?.container.resourceLimits.cpu,
    settings?.container.resourceLimits.memory,
  ])

  useEffect(() => {
    if (!settings || updateSettings.isPending) return
    setCustomEnvVarsDraft(settings.customEnvVars ?? {})
  }, [settings?.customEnvVars, updateSettings.isPending])

  // Initialize runtime settings form when runner changes or settings load
  useEffect(() => {
    if (!settings || !containerRunner) return
    const saved = settings.container.runtimeSettings?.[containerRunner] ?? {}
    const fields = RUNTIME_SETTINGS[containerRunner] ?? []
    const form: Record<string, string> = {}
    for (const field of fields) {
      form[field.key] = saved[field.key] || field.defaultValue
    }
    setRuntimeSettingsForm(form)
  }, [containerRunner, settings?.container.runtimeSettings])

  // Check for changes (main settings only — runtime settings have their own save)
  useEffect(() => {
    if (!settings || !containerRunner) return

    const changed =
      containerRunner !== settings.container.containerRunner ||
      (!agentImageLocked && agentImage !== settings.container.agentImage) ||
      cpuLimit !== settings.container.resourceLimits.cpu.toString() ||
      memoryLimit !== settings.container.resourceLimits.memory

    setHasChanges(changed)
  }, [containerRunner, agentImage, cpuLimit, memoryLimit, settings, agentImageLocked])

  const latestAgentImage = getDefaultAgentImage()
  const trimmedAgentImage = agentImage.trim()
  const agentImageMissing = !agentImageLocked && trimmedAgentImage.length === 0

  const handleStartRunner = async (runner: string) => {
    startRunner.reset()
    try {
      await startRunner.mutateAsync(runner)
      setContainerRunner(runner)
    } catch (error) {
      console.error('Failed to start runner:', error)
    }
  }

  const handleSave = async () => {
    if (agentImageMissing) return
    try {
      await updateSettings.mutateAsync({
        container: {
          containerRunner,
          // A locked field never submits edits — keep whatever is persisted.
          agentImage: agentImageLocked
            ? (settings?.container.agentImage ?? trimmedAgentImage)
            : trimmedAgentImage,
          resourceLimits: {
            cpu: parseInt(cpuLimit, 10) || 1,
            memory: memoryLimit,
          },
        },
      })
    } catch (error) {
      console.error('Failed to save settings:', error)
    }
  }

  const handleReset = () => {
    if (settings) {
      setContainerRunner(settings.container.containerRunner)
      setAgentImage(settings.container.agentImage)
      setCpuLimit(settings.container.resourceLimits.cpu.toString())
      setMemoryLimit(settings.container.resourceLimits.memory)
    }
  }

  const persistCustomEnvVars = async (updated: Record<string, string>) => {
    // Remember the last-good draft so a rejected save can be rolled back instead
    // of leaving the bad value on screen as if it had saved (SUP-239 bug 1).
    const previous = customEnvVarsDraft
    setCustomEnvVarsDraft(updated)

    // Mirror the server-side reserved-runtime-var guard (SUP-210) client-side so
    // the rejection is instant and the offending row never lingers.
    const reserved = findReservedEnvVarKeys(updated)
    const providerError = providerEnvVarsError(updated)
    if (reserved.length > 0 || providerError) {
      setCustomEnvVarsDraft(previous)
      setCustomEnvError(
        providerError ?? `customEnvVars may not override reserved runtime variables: ${reserved.join(', ')}`
      )
      return
    }

    setCustomEnvError(null)
    try {
      await updateSettings.mutateAsync({ customEnvVars: updated })
    } catch (error) {
      // The server did not persist (e.g. 400) — revert so the draft reflects
      // what is actually saved rather than the rejected value.
      setCustomEnvVarsDraft(previous)
      const message =
        error && typeof error === 'object' && 'error' in error && typeof error.error === 'string'
          ? error.error
          : 'Failed to save custom environment variables'
      setCustomEnvError(message)
      console.error('Failed to save custom env vars:', error)
    }
  }

  const handleAddCustomEnvVar = async () => {
    const envName = normalizeEnvVarName(newEnvName)
    if (!envName) {
      setDialogEnvError('Environment variable name is required.')
      return
    }
    if (envName in customEnvVarsDraft) {
      setDialogEnvError('That environment variable already exists.')
      return
    }

    await persistCustomEnvVars({ ...customEnvVarsDraft, [envName]: newEnvValue })
    setNewEnvName('')
    setNewEnvValue('')
    setIsAddEnvDialogOpen(false)
  }

  // Save runtime-specific settings and restart the runtime
  const handleSaveRuntimeSettings = async () => {
    try {
      // Save the settings first
      await updateSettings.mutateAsync({
        container: {
          ...settings?.container,
          runtimeSettings: {
            ...settings?.container.runtimeSettings,
            [containerRunner]: runtimeSettingsForm,
          },
        },
      })
      // Restart the runtime so changes take effect
      await restartRunner.mutateAsync(containerRunner)
    } catch (error) {
      console.error('Failed to save runtime settings:', error)
    }
  }

  const handleResetRuntimeSettings = () => {
    const saved = settings?.container.runtimeSettings?.[containerRunner] ?? {}
    const fields = RUNTIME_SETTINGS[containerRunner] ?? []
    const form: Record<string, string> = {}
    for (const field of fields) {
      form[field.key] = saved[field.key] || field.defaultValue
    }
    setRuntimeSettingsForm(form)
  }

  const hasRunningAgents = settings?.hasRunningAgents ?? false

  // Check if restricted fields have changed
  const restrictedFieldsChanged =
    settings &&
    (containerRunner !== settings.container.containerRunner ||
     cpuLimit !== settings.container.resourceLimits.cpu.toString() ||
     memoryLimit !== settings.container.resourceLimits.memory)

  const saveBlocked = hasRunningAgents && restrictedFieldsChanged
  const runtimeSaveBlocked = hasRunningAgents
  const isRestarting = restartRunner.isPending || updateSettings.isPending

  return (
    <div className="space-y-6">
      {/* Save/Reset — main settings only. On the page title's row, so they are in reach wherever the change was made. */}
      {hasChanges && (
        <SettingsHeaderActions>
          {updateSettings.error && (
            <p className="max-w-[240px] truncate text-xs text-destructive" title={updateSettings.error.error}>
              {updateSettings.error.error}
            </p>
          )}
          <Button variant="soft" size="sm" onClick={handleReset} disabled={updateSettings.isPending}>
            Reset
          </Button>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={updateSettings.isPending || saveBlocked || agentImageMissing}
          >
            {updateSettings.isPending ? 'Applying...' : 'Apply'}
          </Button>
        </SettingsHeaderActions>
      )}

      {/* No runners available warning */}
      {noRunnersAvailable && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>No Container Runtime Available</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>No container runtime was detected as running on your system.</p>
            {hasStartableRunner && (
              <div className="flex gap-2 mt-2">
                {settings?.runnerAvailability
                  ?.filter((r) => !r.running && r.canStart)
                  .map((r) => (
                    <Button
                      key={r.runner}
                      size="sm"
                      variant="soft"
                      onClick={() => handleStartRunner(r.runner)}
                      disabled={startRunner.isPending}
                    >
                      {startRunner.isPending ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : r.installed ? (
                        <Play className="h-4 w-4 mr-2" />
                      ) : (
                        <Download className="h-4 w-4 mr-2" />
                      )}
                      {r.installed ? 'Start' : 'Install'}{' '}
                      {RUNNER_LABELS[r.runner] || r.runner.charAt(0).toUpperCase() + r.runner.slice(1)}
                    </Button>
                  ))}
              </div>
            )}
            {!hasStartableRunner && (
              <p className="text-xs">Please install a container runtime to use Gamut.</p>
            )}
          </AlertDescription>
        </Alert>
      )}

      {/* Image pull / runtime install progress */}
      {(settings?.runtimeReadiness?.status === 'PULLING_IMAGE' ||
        (settings?.runtimeReadiness?.status === 'CHECKING' && settings.runtimeReadiness.pullProgress)) && (
        <Alert>
          <Loader2 className="h-4 w-4 animate-spin" />
          <AlertTitle>
            {settings.runtimeReadiness.status === 'PULLING_IMAGE' ? 'Pulling Agent Image' : 'Setting Up Runtime'}
          </AlertTitle>
          <AlertDescription className="space-y-2">
            <RuntimeProvisionProgress
              progress={
                settings.runtimeReadiness.pullProgress ?? {
                  status: settings.runtimeReadiness.message || 'Working...',
                  percent: null,
                }
              }
            />
          </AlertDescription>
        </Alert>
      )}

      {/* Image pull error */}
      {settings?.runtimeReadiness?.status === 'ERROR' && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Image Pull Failed</AlertTitle>
          <AlertDescription>{settings.runtimeReadiness.message}</AlertDescription>
        </Alert>
      )}

      {hasRunningAgents && (
        <div className="flex items-start gap-2 p-3 text-sm bg-yellow-500/10 border border-yellow-500/20 rounded-card">
          <AlertCircle className="h-4 w-4 text-yellow-500 mt-0.5 shrink-0" />
          <p className="text-yellow-700 dark:text-yellow-400">
            Some settings cannot be changed while agents are running. Stop all agents to modify container runtime or resource limits.
          </p>
        </div>
      )}

      <div className="space-y-2">
        <h3 className={SETTINGS_SECTION_HEADING}>Runtime</h3>
        <div className={SETTINGS_CARD_CLASS}>
          <SettingRow
            name="Container runtime"
            htmlFor="container-runner"
            right={
              <>
                <Select
                  variant="row"
                  value={containerRunner}
                  onValueChange={setContainerRunner}
                  disabled={isLoading || hasRunningAgents}
                >
                  <SelectTrigger id="container-runner">
                    <SelectValue placeholder="Select a container runtime" />
                  </SelectTrigger>
                  <SelectContent>
                    {containerRunners.map((runner) => {
                      const status = runnerAvailabilityMap.get(runner.value)
                      const isAvailable = status?.available ?? true
                      const isInstalled = status?.installed ?? true
                      const canStart = status?.canStart ?? false
                      const isSelectable = isAvailable || canStart

                      let statusText = ''
                      if (!isInstalled) {
                        statusText = ' (not installed)'
                      } else if (!isAvailable && !canStart) {
                        statusText = ' (not running)'
                      }

                      return (
                        <SelectItem
                          key={runner.value}
                          value={runner.value}
                          disabled={!isSelectable}
                          className={!isSelectable ? 'opacity-50' : ''}
                        >
                          {runner.label}
                          {statusText}
                        </SelectItem>
                      )
                    })}
                  </SelectContent>
                </Select>
                {/* Show start/install when selected runner canStart (incl. apple first-install) */}
                {!runnerAvailabilityMap.get(containerRunner)?.running &&
                  runnerAvailabilityMap.get(containerRunner)?.canStart && (
                  <Button
                    variant="soft"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => handleStartRunner(containerRunner)}
                    disabled={startRunner.isPending}
                    title={
                      runnerAvailabilityMap.get(containerRunner)?.installed
                        ? `Start ${containerRunner}`
                        : `Install ${containerRunner}`
                    }
                  >
                    {startRunner.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : runnerAvailabilityMap.get(containerRunner)?.installed ? (
                      <Play className="h-4 w-4" />
                    ) : (
                      <Download className="h-4 w-4" />
                    )}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => refreshAvailability.mutate()}
                  disabled={refreshAvailability.isPending}
                  title="Refresh runtime availability"
                >
                  <RefreshCw className={`h-4 w-4 ${refreshAvailability.isPending ? 'animate-spin' : ''}`} />
                </Button>
              </>
            }
          >
            {/* What the runtime is doing or needs right now. */}
            <div className="text-[11px] text-muted-foreground empty:hidden">
              {containerRunners.some(r => r.value === 'wsl2') &&
                !runnerAvailabilityMap.get('wsl2')?.installed && (
                <span className="text-yellow-600 dark:text-yellow-400 block mt-2">
                  WSL2 is not installed. Run <code className="bg-muted px-1 rounded">wsl --install</code> in PowerShell as Administrator, then restart your computer.
                </span>
              )}
              {restartRunner.isPending && (
                <span className="text-yellow-600 dark:text-yellow-400 mt-2 flex items-center gap-1">
                  <Loader2 className="h-3 w-3 animate-spin inline" />
                  Restarting {RUNNER_LABELS[containerRunner] || containerRunner}...
                </span>
              )}
              {startRunner.displayError && getRunnerSetupPayload(startRunner.displayError) ? (
                <div className="mt-2">
                  <RunnerSetupErrorPanel error={startRunner.displayError} />
                </div>
              ) : startRunner.displayError ? (
                <span className="text-destructive block mt-2">
                  {startRunner.displayError.message}
                </span>
              ) : null}
              {startRunner.isSuccess && startRunner.data?.message && !startRunner.displayError && (
                <span className="text-green-600 dark:text-green-400 block mt-2">
                  {startRunner.data.message}
                </span>
              )}
            </div>
          </SettingRow>

          <SettingRow
            name="Agent image"
            // Only when the deployment decides it: otherwise the dropdown speaks for itself.
            status={agentImageLocked ? 'Agent image is managed by the deployment for this runner and cannot be changed here.' : undefined}
            htmlFor="agent-image"
            stack
            right={
              <AgentImageSelect
                id="agent-image"
                value={agentImage}
                defaultImage={latestAgentImage}
                onChange={setAgentImage}
                disabled={isLoading || agentImageLocked}
              />
            }
          >
            {agentImageMissing && (
              <p className="mt-2 text-[11px] text-destructive">Agent image is required.</p>
            )}
          </SettingRow>

          <SettingRow
            name="CPU limit per agent"
            htmlFor="cpu-limit"
            right={
              <Select
                variant="row"
                value={cpuLimit}
                onValueChange={setCpuLimit}
                disabled={isLoading || hasRunningAgents}
              >
                <SelectTrigger id="cpu-limit">
                  <SelectValue placeholder="Select CPU cores" />
                </SelectTrigger>
                <SelectContent>
                  {(CPU_LIMIT_OPTIONS.map(String).includes(cpuLimit)
                    ? CPU_LIMIT_OPTIONS.map(String)
                    : cpuLimit
                      ? [cpuLimit, ...CPU_LIMIT_OPTIONS.map(String)]
                      : CPU_LIMIT_OPTIONS.map(String)
                  ).map((v) => (
                    <SelectItem key={v} value={v}>
                      {v} {v === '1' ? 'core' : 'cores'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            }
          />

          <SettingRow
            name="Memory limit per agent"
            htmlFor="memory-limit"
            right={
              <Select
                variant="row"
                value={memoryLimit}
                onValueChange={setMemoryLimit}
                disabled={isLoading || hasRunningAgents}
              >
                <SelectTrigger id="memory-limit">
                  <SelectValue placeholder="Select memory limit" />
                </SelectTrigger>
                <SelectContent>
                  {(MEMORY_LIMIT_OPTIONS.some((o) => o.value === memoryLimit) || !memoryLimit
                    ? MEMORY_LIMIT_OPTIONS
                    : [{ value: memoryLimit, label: memoryLimit }, ...MEMORY_LIMIT_OPTIONS]
                  ).map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            }
          />

          {/* Auto-Sleep Idle Containers: stored in minutes, 0 meaning never. */}
          <SettingRow
            name="Stop idle agents after"
            htmlFor="auto-sleep-timeout"
            right={
              <PresetNumberSelect
                id="auto-sleep-timeout"
                label="minutes before an idle agent stops"
                value={idleMinutes === 0 ? undefined : idleMinutes}
                unsetLabel="Never"
                presets={[5, 15, 30, 60, 120]}
                format={formatMinutes}
                min={1}
                step={1}
                placeholder="Minutes"
                onChange={(minutes) => updateSettings.mutate({ app: { autoSleepTimeoutMinutes: minutes ?? 0 } })}
                disabled={isLoading}
              />
            }
          />

          {/* Warm-start on typing */}
          <SettingRow
            name="Warm start on typing"
            help="Starts the agent's container in the background when you begin typing a first message, so it is ready on send."
            htmlFor="warm-start-on-type"
            right={
              <Switch
                id="warm-start-on-type"
                checked={isWarmStartOnTypeEnabled(settings)}
                onCheckedChange={(checked: boolean) => {
                  updateSettings.mutate({ app: { warmStartOnType: checked } })
                }}
                disabled={isLoading}
              />
            }
          />

          {containerRunner === 'lambda-microvm' && (
            <SettingRow
              name="Auto-resume mid-turn sessions"
              help="If the MicroVM dies while a session is still working, continues the turn instead of showing a connection-lost error."
              htmlFor="auto-resume-on-unexpected-death"
              right={
                <Switch
                  id="auto-resume-on-unexpected-death"
                  checked={isAutoResumeOnUnexpectedDeathEnabled(settings)}
                  onCheckedChange={(checked: boolean) => {
                    updateSettings.mutate({ app: { autoResumeOnUnexpectedDeath: checked } })
                  }}
                  disabled={isLoading}
                />
              }
            />
          )}
        </div>
      </div>

      {/* Runtime-specific settings */}
      {currentRunnerFields.length > 0 && (
        <div className="space-y-2">
          <h3 className={SETTINGS_SECTION_HEADING}>{RUNNER_LABELS[containerRunner] || containerRunner} settings</h3>
          <div className={SETTINGS_CARD_CLASS}>
            {currentRunnerFields.map((field) => (
              <SettingRow
                key={field.key}
                name={field.label}
                help={field.description}
                htmlFor={`runtime-${field.key}`}
                stack={field.type !== 'select'}
                right={field.type === 'select' && field.options ? (
                  <Select
                    variant="row"
                    value={runtimeSettingsForm[field.key] || field.defaultValue}
                    onValueChange={(value) =>
                      setRuntimeSettingsForm((prev) => ({ ...prev, [field.key]: value }))
                    }
                    disabled={isLoading || runtimeSaveBlocked || isRestarting}
                  >
                    <SelectTrigger id={`runtime-${field.key}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {field.options.map((opt) => {
                        const oversized =
                          field.key === 'vmMemory' && assessVmMemoryOption(opt.value).level === 'refuse'
                        return (
                          <SelectItem key={opt.value} value={opt.value} disabled={oversized}>
                            {opt.label}
                            {oversized ? ' (exceeds system memory)' : ''}
                          </SelectItem>
                        )
                      })}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    id={`runtime-${field.key}`}
                    value={runtimeSettingsForm[field.key] || ''}
                    onChange={(e) =>
                      setRuntimeSettingsForm((prev) => ({ ...prev, [field.key]: e.target.value }))
                    }
                    disabled={isLoading || runtimeSaveBlocked || isRestarting}
                    className="h-8 w-full md:w-[220px] text-xs"
                  />
                )}
              >
                {field.key === 'vmMemory' && vmMemoryAssessment.level === 'warn' && (
                  <p className="mt-2 text-[11px] text-yellow-600 dark:text-yellow-400">
                    {vmMemoryAssessment.message}
                  </p>
                )}
                {field.key === 'vmMemory' && vmMemoryAssessment.level === 'refuse' && (
                  <p className="mt-2 text-[11px] text-destructive">{vmMemoryAssessment.message}</p>
                )}
              </SettingRow>
            ))}

            {runtimeSettingsChanged && (
              <div className="flex items-center justify-end gap-2 py-3 px-4">
                {restartRunner.error && getRunnerSetupPayload(restartRunner.error) ? (
                  <div className="mr-auto w-full">
                    <RunnerSetupErrorPanel error={restartRunner.error} />
                  </div>
                ) : restartRunner.error ? (
                  <p className="text-xs text-destructive mr-auto">
                    {restartRunner.error.message}
                  </p>
                ) : null}
                {restartRunner.isSuccess && restartRunner.data?.message && (
                  <p className="text-xs text-green-600 dark:text-green-400 mr-auto">
                    {restartRunner.data.message}
                  </p>
                )}
                <Button
                  variant="soft"
                  size="sm"
                  onClick={handleResetRuntimeSettings}
                  disabled={isRestarting}
                >
                  Reset
                </Button>
                <Button
                  size="sm"
                  onClick={handleSaveRuntimeSettings}
                  disabled={isRestarting || runtimeSaveBlocked || vmMemoryAssessment.level === 'refuse'}
                >
                  {isRestarting ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Restarting...
                    </>
                  ) : (
                    'Save & restart'
                  )}
                </Button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Agent Limits: suggested values, with Custom… for anything else. Unset follows the default. */}
      <div className="space-y-2">
        <h3 className={SETTINGS_SECTION_HEADING}>Agent limits</h3>
        <div className={SETTINGS_CARD_CLASS}>
          <SettingRow
            name="Max output tokens per response"
            htmlFor="max-output-tokens"
            right={
              <PresetNumberSelect
                id="max-output-tokens"
                label="max output tokens per response"
                value={settings?.agentLimits?.maxOutputTokens}
                unsetLabel="Default (32,000)"
                presets={[16000, 64000, 128000]}
                min={1024}
                step={1024}
                onChange={(value) => updateSettings.mutate({ agentLimits: { maxOutputTokens: value ?? null } })}
                disabled={isLoading}
              />
            }
          />
          <SettingRow
            name="Max thinking tokens"
            htmlFor="max-thinking-tokens"
            right={
              <PresetNumberSelect
                id="max-thinking-tokens"
                label="max thinking tokens"
                value={settings?.agentLimits?.maxThinkingTokens}
                unsetLabel="Unlimited"
                presets={[4000, 16000, 32000, 64000]}
                min={1024}
                step={1024}
                onChange={(value) => updateSettings.mutate({ agentLimits: { maxThinkingTokens: value ?? null } })}
                disabled={isLoading}
              />
            }
          />
          <SettingRow
            name="Max turns per session"
            htmlFor="max-turns"
            right={
              <PresetNumberSelect
                id="max-turns"
                label="max turns per session"
                value={settings?.agentLimits?.maxTurns}
                unsetLabel="Unlimited"
                presets={[25, 50, 100, 250]}
                min={1}
                step={1}
                onChange={(value) => updateSettings.mutate({ agentLimits: { maxTurns: value ?? null } })}
                disabled={isLoading}
              />
            }
          />
          <SettingRow
            name="Max cost per session"
            htmlFor="max-budget-usd"
            right={
              <PresetNumberSelect
                id="max-budget-usd"
                label="max cost per session in US dollars"
                value={settings?.agentLimits?.maxBudgetUsd}
                unsetLabel="Unlimited"
                presets={[1, 5, 10, 25, 50]}
                format={formatUsd}
                min={0.01}
                step={0.01}
                fractional
                onChange={(value) => updateSettings.mutate({ agentLimits: { maxBudgetUsd: value ?? null } })}
                disabled={isLoading}
              />
            }
          />
        </div>
      </div>

      {/* Custom Environment Variables */}
      <div className="space-y-2" data-testid="runtime-custom-env">
        <h3 className={SETTINGS_SECTION_HEADING}>Custom environment variables</h3>
        <div className={SETTINGS_CARD_CLASS}>
          {Object.entries(customEnvVarsDraft).map(([key, value]) => (
            <div
              key={key}
              className="flex items-center gap-2 py-2 pl-4 pr-2"
              data-testid="custom-env-var-row"
              data-env-var-key={key}
            >
              <Input
                value={key}
                className="h-8 font-mono text-xs flex-[2]"
                disabled
                aria-label="Variable name"
                data-testid="custom-env-var-key"
              />
              <Input
                value={value}
                className="h-8 font-mono text-xs flex-[3]"
                maxLength={4096}
                aria-label={`Value of ${key}`}
                onChange={(e) => {
                  setCustomEnvVarsDraft((prev) => ({ ...prev, [key]: e.target.value }))
                }}
                onBlur={(e) => {
                  const val = e.target.value
                  setCustomEnvVarsDraft((prev) => {
                    const updated = { ...prev, [key]: val }
                    persistCustomEnvVars(updated)
                    return updated
                  })
                }}
                disabled={isLoading || updateSettings.isPending}
                data-testid="custom-env-var-value"
              />
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0"
                aria-label={`Remove ${key}`}
                data-testid="custom-env-var-delete"
                onClick={async () => {
                  const updated = { ...customEnvVarsDraft }
                  delete updated[key]
                  await persistCustomEnvVars(updated)
                }}
                disabled={isLoading || updateSettings.isPending}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}

          <SettingRow
            name="Variables for agent tools and the agent runtime"
            help="Shared by every agent and applied to new sessions. LLM credentials and endpoints belong on the connection instead: Settings → Model Providers → edit a connection."
            right={
              <Button
                variant="soft"
                size="sm"
                onClick={() => setIsAddEnvDialogOpen(true)}
                disabled={isLoading || updateSettings.isPending}
              >
                <Plus className="h-4 w-4 mr-2" />
                Add variable
              </Button>
            }
          >
            {customEnvError && (
              <p className="mt-2 text-[11px] text-destructive">{customEnvError}</p>
            )}
          </SettingRow>
        </div>
      </div>

      <Dialog
        open={isAddEnvDialogOpen}
        onOpenChange={(open) => {
          setIsAddEnvDialogOpen(open)
          if (!open) {
            setNewEnvName('')
            setNewEnvValue('')
            setDialogEnvError(null)
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Custom Environment Variable</DialogTitle>
            <DialogDescription>
              These variables apply across providers. For LLM credentials and endpoints, edit the connection in Settings → LLM.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={(e) => { e.preventDefault(); handleAddCustomEnvVar() }}>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="custom-env-name">Variable Name</Label>
                <Input
                  id="custom-env-name"
                  value={newEnvName}
                  onChange={(e) => { setNewEnvName(e.target.value); setDialogEnvError(null) }}
                  placeholder="CLAUDE_CODE_MAX_OUTPUT_TOKENS"
                  className="font-mono text-sm"
                  maxLength={256}
                  autoFocus
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="custom-env-value">Value</Label>
                <Input
                  id="custom-env-value"
                  value={newEnvValue}
                  onChange={(e) => setNewEnvValue(e.target.value)}
                  placeholder="32000"
                  className="font-mono text-sm"
                  maxLength={4096}
                />
              </div>

              {dialogEnvError && (
                <p className="text-xs text-destructive">{dialogEnvError}</p>
              )}
            </div>

            <DialogFooter className="mt-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => setIsAddEnvDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={isLoading || updateSettings.isPending}
              >
                Add variable
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Data Location - Read Only */}
      <div className="space-y-2">
        <h3 className={SETTINGS_SECTION_HEADING}>Data</h3>
        <div className={SETTINGS_CARD_CLASS}>
          <SettingRow
            name="Data location"
            help={<>Set with the <code className="font-mono">SUPERAGENT_DATA_DIR</code> environment variable.</>}
            htmlFor="data-location"
            stack
            right={
              <Input
                id="data-location"
                value={isLoading ? 'Loading...' : settings?.dataDir ?? ''}
                readOnly
                className="h-8 w-full md:w-[320px] bg-muted font-mono text-xs"
              />
            }
          />
        </div>
      </div>

    </div>
  )
}
