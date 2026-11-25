import { useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { useSettings, useUpdateSettings } from '@renderer/hooks/use-settings'
import { PolicyDecisionDropdown } from '@renderer/components/ui/policy-decision-toggle'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog'
import type { CapabilityPolicy } from '@shared/lib/config/settings'
import { SETTINGS_CARD_CLASS, SETTINGS_SECTION_HEADING, SettingRow } from './setting-row'

const CARD_CLASS = SETTINGS_CARD_CLASS
const SECTION_HEADING = SETTINGS_SECTION_HEADING

export function CapabilitiesTab() {
  const { data: settings, isLoading } = useSettings()
  const updateSettings = useUpdateSettings()
  // Blocking subagents cripples genuinely useful delegation (browsing,
  // dashboards) — confirm before applying and steer toward review instead.
  const [confirmBlockSubagents, setConfirmBlockSubagents] = useState(false)

  const capabilities = settings?.agentCapabilities ?? { subagents: 'allow', workflows: 'review' }

  const setPolicy = (capability: 'subagents' | 'workflows', policy: CapabilityPolicy) => {
    updateSettings.mutate({ agentCapabilities: { [capability]: policy } })
  }

  const handleSubagentsChange = (value: string) => {
    if (value !== 'allow' && value !== 'review' && value !== 'block') return
    if (value === 'block') {
      setConfirmBlockSubagents(true)
      return
    }
    setPolicy('subagents', value)
  }

  const handleWorkflowsChange = (value: string) => {
    if (value !== 'allow' && value !== 'review' && value !== 'block') return
    setPolicy('workflows', value)
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h3 className={SECTION_HEADING}>Launch policies</h3>
        <div className={CARD_CLASS}>
          <SettingRow
            name="Subagents"
            help="Agents another agent launches to delegate work: browsing, dashboards, research. Review pauses each launch for your approval; Block removes the ability entirely."
            right={
              <div data-testid="capability-policy-subagents" className={isLoading ? 'pointer-events-none opacity-50' : undefined}>
                <PolicyDecisionDropdown
                  value={capabilities.subagents}
                  onChange={handleSubagentsChange}
                  includeDefault={false}
                />
              </div>
            }
          />
          <SettingRow
            name="Workflows"
            help="Multi-agent runs an agent orchestrates. A single workflow can fan out into dozens of agents, so these default to Review."
            right={
              <div data-testid="capability-policy-workflows" className={isLoading ? 'pointer-events-none opacity-50' : undefined}>
                <PolicyDecisionDropdown
                  value={capabilities.workflows}
                  onChange={handleWorkflowsChange}
                  includeDefault={false}
                />
              </div>
            }
          />
        </div>
        <p className="px-1 text-[11px] text-muted-foreground leading-relaxed">
          Policies apply to every agent. Under Review, approving with &ldquo;Allow for this session&rdquo; stops
          repeat prompts within that conversation. Changes take effect from each session&apos;s next message.
        </p>
      </div>

      <AlertDialog open={confirmBlockSubagents} onOpenChange={setConfirmBlockSubagents}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              Block subagents everywhere?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Subagents power core features — web browsing, dashboard building, and desktop
              automation all delegate to them. Blocking removes those abilities from every agent.
              If cost control is the goal, <span className="font-medium text-foreground">Review</span> keeps
              the capability while letting you approve each launch.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="block-subagents-cancel">Keep current setting</AlertDialogCancel>
            <AlertDialogAction
              data-testid="block-subagents-use-review"
              onClick={() => setPolicy('subagents', 'review')}
            >
              Use Review instead
            </AlertDialogAction>
            <AlertDialogAction
              data-testid="block-subagents-confirm"
              className="bg-orange-600 text-white hover:bg-orange-700"
              onClick={() => setPolicy('subagents', 'block')}
            >
              Block anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
