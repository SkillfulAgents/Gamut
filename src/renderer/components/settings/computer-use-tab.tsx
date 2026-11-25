import { useSettings, useUpdateSettings } from '@renderer/hooks/use-settings'
import { useAgents } from '@renderer/hooks/use-agents'
import { computerUseSupported } from '@renderer/lib/capabilities'
import { Alert, AlertDescription, AlertTitle } from '@renderer/components/ui/alert'
import { Button } from '@renderer/components/ui/button'
import { Switch } from '@renderer/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
import { TriangleAlert } from 'lucide-react'
import {
  computerUsePreferences,
  PERMISSION_LEVEL_LABELS,
  type ComputerUseInputMode,
  type ComputerUseSettings,
} from '@shared/lib/computer-use/types'
import { SETTINGS_CARD_CLASS, SETTINGS_SECTION_HEADING, SettingRow } from './setting-row'

const CARD_CLASS = SETTINGS_CARD_CLASS
const SECTION_HEADING = SETTINGS_SECTION_HEADING

// Stored as 'headed' / 'headless'; what they mean now is whether agents may
// ask for real pointer and keyboard input (agent-desktop's --headed).
const INPUT_MODE_LABELS: Record<ComputerUseInputMode, string> = {
  headed: 'Allowed',
  headless: 'Never',
}

export function ComputerUseTab() {
  const { data: settings } = useSettings()
  const { data: agents } = useAgents()
  const updateSettings = useUpdateSettings()

  if (!computerUseSupported()) {
    return (
      <Alert>
        <TriangleAlert className="h-4 w-4" />
        <AlertTitle>Not Available</AlertTitle>
        <AlertDescription>
          Computer Use is only available on macOS and Windows in the Electron desktop app.
        </AlertDescription>
      </Alert>
    )
  }

  const computerUse = settings?.computerUse as ComputerUseSettings | undefined
  const { showCursor, inputMode } = computerUsePreferences(computerUse)
  const agentPermissions = computerUse?.agentPermissions || {}
  const hasGrants = Object.keys(agentPermissions).length > 0

  // Map slug → display name
  const agentNameMap = new Map(agents?.map((a) => [a.slug, a.name]) ?? [])
  const displayName = (agentSlug: string) => agentNameMap.get(agentSlug) ?? agentSlug

  const handleRevokeAll = (agentSlug: string) => {
    const newPerms = { ...agentPermissions }
    delete newPerms[agentSlug]
    updateSettings.mutate({
      computerUse: { agentPermissions: newPerms },
    })
  }

  const handleRevokeGrant = (agentSlug: string, grantIndex: number) => {
    const agentGrants = agentPermissions[agentSlug]?.grants || []
    const newGrants = agentGrants.filter((_, i) => i !== grantIndex)
    const newPerms = { ...agentPermissions }
    if (newGrants.length === 0) {
      delete newPerms[agentSlug]
    } else {
      newPerms[agentSlug] = { grants: newGrants }
    }
    updateSettings.mutate({
      computerUse: { agentPermissions: newPerms },
    })
  }

  return (
    <div className="space-y-6">
      <div className="flex gap-2 rounded-item bg-yellow-500/10 px-2.5 py-2 text-[11px] text-yellow-700 dark:text-yellow-500/90 leading-relaxed">
        <TriangleAlert className="h-3.5 w-3.5 mt-0.5 shrink-0" />
        <p>
          Agents interact with applications on your machine using your user permissions.
          Review each request carefully and only grant persistent access to trusted agents.
        </p>
      </div>

      <div className="space-y-2">
        <h3 className={SECTION_HEADING}>How agents work</h3>
        <div className={CARD_CLASS}>
          <SettingRow
            name="Show each agent's cursor on screen"
            htmlFor="computer-use-show-cursor"
            right={
              <Switch
                id="computer-use-show-cursor"
                checked={showCursor}
                onCheckedChange={(checked) => updateSettings.mutate({ computerUse: { showCursor: checked } })}
                disabled={updateSettings.isPending}
              />
            }
          />
          <SettingRow
            name="Let agents take your pointer and keyboard"
            help="Agents normally act through accessibility, without moving your pointer. Double-click, hover, drag and clicking something with no accessible control need real input: when allowed, the agent brings the app forward and moves your pointer for those. With Never, those actions are unavailable."
            htmlFor="computer-use-input-mode"
            right={
              <Select
                variant="row"
                value={inputMode}
                onValueChange={(value) => updateSettings.mutate({ computerUse: { inputMode: value as ComputerUseInputMode } })}
                disabled={updateSettings.isPending}
              >
                <SelectTrigger id="computer-use-input-mode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(INPUT_MODE_LABELS) as ComputerUseInputMode[]).map((mode) => (
                    <SelectItem key={mode} value={mode}>{INPUT_MODE_LABELS[mode]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            }
          />
        </div>
      </div>

      <div className="space-y-2">
        <h3 className={SECTION_HEADING}>Persistent permissions</h3>
        {!hasGrants ? (
          <div className={CARD_CLASS}>
            <p className="py-3 px-4 text-[11px] text-muted-foreground leading-relaxed">
              Agents you grant `always allow` computer use permissions will appear here.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {Object.entries(agentPermissions).map(([agentSlug, agentPerms]) => (
              <div key={agentSlug} className={CARD_CLASS}>
                <div className="group flex items-center justify-between py-2 pl-4 pr-2">
                  <span className="text-xs font-medium truncate">{displayName(agentSlug)}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleRevokeAll(agentSlug)}
                    aria-label={`Revoke all computer use permissions for ${displayName(agentSlug)}`}
                    className="h-7 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
                  >
                    Revoke all
                  </Button>
                </div>
                {agentPerms.grants.map((grant, i) => (
                  <div key={i} className="group flex items-center justify-between py-2 pl-4 pr-2">
                    <span className="text-[11px] text-muted-foreground truncate">
                      {PERMISSION_LEVEL_LABELS[grant.level] || grant.level}
                      {grant.appName ? ` — ${grant.appName}` : ''}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleRevokeGrant(agentSlug, i)}
                      aria-label={`Revoke ${
                        grant.appName
                          ? `${PERMISSION_LEVEL_LABELS[grant.level]} — ${grant.appName}`
                          : PERMISSION_LEVEL_LABELS[grant.level]
                      } permission for ${displayName(agentSlug)}`}
                      className="h-6 px-2 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
                    >
                      Revoke
                    </Button>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
