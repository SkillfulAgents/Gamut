import { useState } from 'react'
import { Label } from '@renderer/components/ui/label'
import { Input } from '@renderer/components/ui/input'
import { Button } from '@renderer/components/ui/button'
import { Switch } from '@renderer/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
import { useSettings, useUpdateSettings } from '@renderer/hooks/use-settings'
import { useUser } from '@renderer/context/user-context'
import { Plus, Trash2 } from 'lucide-react'
import type { AnalyticsTarget, AnalyticsTargetType } from '@shared/lib/config/settings'
import { SETTINGS_CARD_CLASS, SETTINGS_SECTION_HEADING, SettingRow } from './setting-row'

const TARGET_TYPE_LABELS: Record<AnalyticsTargetType, string> = {
  amplitude: 'Amplitude',
  'google-analytics': 'Google Analytics',
  mixpanel: 'Mixpanel',
}

const TARGET_CONFIG_FIELDS: Record<AnalyticsTargetType, { key: string; label: string; placeholder: string }[]> = {
  amplitude: [{ key: 'apiKey', label: 'API Key', placeholder: 'Enter Amplitude API key' }],
  'google-analytics': [{ key: 'measurementId', label: 'Measurement ID', placeholder: 'G-XXXXXXXXXX' }],
  mixpanel: [{ key: 'token', label: 'Project Token', placeholder: 'Enter Mixpanel project token' }],
}

export function AnalyticsTab() {
  const { data: settings, isLoading: isSettingsLoading } = useSettings()
  const updateSettings = useUpdateSettings()
  const { isAdmin } = useUser()

  const targets = settings?.analyticsTargets ?? []

  const [newTargetType, setNewTargetType] = useState<AnalyticsTargetType>('amplitude')
  const [newTargetConfig, setNewTargetConfig] = useState<Record<string, string>>({})
  const [showAddForm, setShowAddForm] = useState(false)

  const handleAddTarget = () => {
    const fields = TARGET_CONFIG_FIELDS[newTargetType]
    const hasAllFields = fields.every(f => newTargetConfig[f.key]?.trim())
    if (!hasAllFields) return

    const newTarget: AnalyticsTarget = {
      type: newTargetType,
      config: { ...newTargetConfig },
      enabled: true,
    }

    updateSettings.mutate({
      analyticsTargets: [...targets, newTarget],
    })
    setNewTargetConfig({})
    setShowAddForm(false)
  }

  const handleRemoveTarget = (index: number) => {
    const updated = targets.filter((_, i) => i !== index)
    updateSettings.mutate({ analyticsTargets: updated })
  }

  const handleToggleTarget = (index: number, enabled: boolean) => {
    const updated = targets.map((t, i) => i === index ? { ...t, enabled } : t)
    updateSettings.mutate({ analyticsTargets: updated })
  }

  return (
    <div className="space-y-6">
      <div className={SETTINGS_CARD_CLASS}>
        <SettingRow
          name="Share error reports"
          htmlFor="share-error-reports"
          right={
            <Switch
              id="share-error-reports"
              checked={settings?.shareErrorReports !== false}
              onCheckedChange={(checked: boolean) => {
                updateSettings.mutate({ shareErrorReports: checked })
              }}
              disabled={isSettingsLoading}
            />
          }
        />
        <SettingRow
          name="Share anonymous usage data"
          htmlFor="share-analytics"
          right={
            <Switch
              id="share-analytics"
              checked={!!settings?.shareAnalytics}
              onCheckedChange={(checked: boolean) => {
                updateSettings.mutate({ shareAnalytics: checked })
              }}
              disabled={isSettingsLoading}
            />
          }
        />
      </div>

      {/* Analytics Targets - Admin only */}
      {isAdmin && (
        <div className="space-y-2">
          <h3 className={SETTINGS_SECTION_HEADING}>Analytics targets</h3>
          <div className={SETTINGS_CARD_CLASS}>
            {targets.map((target, index) => (
              <SettingRow
                key={index}
                name={TARGET_TYPE_LABELS[target.type]}
                // Which key this target sends with: data, not a description.
                status={Object.entries(target.config).map(([k, v]) =>
                  `${k}: ${v.slice(0, 8)}...`
                ).join(', ')}
                right={
                  <>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => handleRemoveTarget(index)}
                      aria-label={`Remove ${TARGET_TYPE_LABELS[target.type]} target`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                    <Switch
                      checked={target.enabled}
                      onCheckedChange={(checked) => handleToggleTarget(index, checked)}
                      aria-label={`Send events to ${TARGET_TYPE_LABELS[target.type]}`}
                    />
                  </>
                }
              />
            ))}

            {showAddForm ? (
              <div className="space-y-3 py-3 px-4">
                <Select
                  value={newTargetType}
                  onValueChange={(v) => {
                    setNewTargetType(v as AnalyticsTargetType)
                    setNewTargetConfig({})
                  }}
                >
                  <SelectTrigger aria-label="Analytics provider">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="amplitude">Amplitude</SelectItem>
                    <SelectItem value="google-analytics">Google Analytics</SelectItem>
                    <SelectItem value="mixpanel">Mixpanel</SelectItem>
                  </SelectContent>
                </Select>

                {TARGET_CONFIG_FIELDS[newTargetType].map((field) => (
                  <div key={field.key} className="space-y-1">
                    <Label htmlFor={`analytics-target-${field.key}`} className="text-xs font-normal">{field.label}</Label>
                    <Input
                      id={`analytics-target-${field.key}`}
                      type="password"
                      placeholder={field.placeholder}
                      value={newTargetConfig[field.key] ?? ''}
                      onChange={(e) => setNewTargetConfig(prev => ({ ...prev, [field.key]: e.target.value }))}
                    />
                  </div>
                ))}

                <div className="flex gap-2">
                  <Button size="sm" onClick={handleAddTarget}>
                    Add
                  </Button>
                  <Button size="sm" variant="soft" onClick={() => { setShowAddForm(false); setNewTargetConfig({}) }}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <SettingRow
                name="Send events to your own analytics provider"
                help="Targets apply to every user of this workspace."
                right={
                  <Button variant="soft" size="sm" onClick={() => setShowAddForm(true)}>
                    <Plus className="h-4 w-4 mr-2" />
                    Add analytics target
                  </Button>
                }
              />
            )}
          </div>
        </div>
      )}
    </div>
  )
}
