import { FlaskConical } from 'lucide-react'
import { Switch } from '@renderer/components/ui/switch'
import { useUserSettings, useUpdateUserSettings } from '@renderer/hooks/use-user-settings'
import { useAnalyticsTracking } from '@renderer/context/analytics-context'
import { experimentEnabled, listExperiments } from '@shared/lib/experiments'
import { SETTINGS_CARD_CLASS, SettingRow } from './setting-row'

const CARD_CLASS = SETTINGS_CARD_CLASS

/**
 * Settings → Experiments: one switch per entry in the experiments registry.
 * Each switch is the viewer's own; nobody else's app changes.
 */
export function ExperimentsTab() {
  const { data: userSettings, isLoading } = useUserSettings()
  const updateUserSettings = useUpdateUserSettings()
  const { track } = useAnalyticsTracking()
  const experiments = listExperiments()

  return (
    <div className="space-y-6">
      <p className="px-1 text-[11px] leading-relaxed text-muted-foreground">
        Features that are still being built. They may change or go away. Turning one on affects only you.
      </p>

      <div className="space-y-2">
        <div className={CARD_CLASS}>
          {experiments.length === 0 ? (
            <div className="flex items-center gap-2 px-4 py-3 text-[11px] text-muted-foreground" data-testid="experiments-empty">
              <FlaskConical className="h-3.5 w-3.5 shrink-0" />
              No experiments right now.
            </div>
          ) : (
            experiments.map((experiment) => {
              const switchId = `experiment-${experiment.id}`
              return (
                <div key={experiment.id} data-testid={`experiment-row-${experiment.id}`}>
                  <SettingRow
                    name={experiment.name}
                    // An experiment is new by definition, so its name alone rarely says what it turns on.
                    help={experiment.description}
                    htmlFor={switchId}
                    right={
                      <Switch
                        id={switchId}
                        checked={experimentEnabled(userSettings?.experiments, experiment.id)}
                        onCheckedChange={(checked: boolean) => {
                          const props = { experiment_key: experiment.id, enabled: checked }
                          updateUserSettings.mutate(
                            { experiments: { [experiment.id]: checked } },
                            {
                              onSuccess: () => track('experiment_toggled', props),
                              onError: () => track('experiment_toggle_failed', props),
                            },
                          )
                        }}
                        disabled={isLoading}
                        data-testid={`experiment-switch-${experiment.id}`}
                      />
                    }
                  />
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
