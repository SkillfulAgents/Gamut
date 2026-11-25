import { useState } from 'react'
import { Button } from '@renderer/components/ui/button'
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
import { useFactoryReset } from '@renderer/hooks/use-settings'
import { RotateCcw, Bug } from 'lucide-react'
import { DebugTab } from './debug-tab'
import { SETTINGS_CARD_CLASS, SETTINGS_SECTION_HEADING, SettingRow } from './setting-row'

const CARD_CLASS = SETTINGS_CARD_CLASS
const SECTION_HEADING = SETTINGS_SECTION_HEADING

export function AdminTab() {
  const factoryReset = useFactoryReset()
  const [isResetting, setIsResetting] = useState(false)
  const [showDebug, setShowDebug] = useState(false)

  const handleFactoryReset = async () => {
    setIsResetting(true)
    try {
      await factoryReset.mutateAsync()
      window.location.reload()
    } catch (error) {
      console.error('Factory reset failed:', error)
      setIsResetting(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h3 className={SECTION_HEADING}>Danger zone</h3>
        <div className={CARD_CLASS}>
          <SettingRow
            name="Delete all agents, sessions, files, and settings"
            right={
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="destructive" size="sm">
                    <RotateCcw className="h-4 w-4 mr-2" />
                    Factory reset
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Factory Reset</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will permanently delete all agents, sessions, files, scheduled tasks,
                      connected accounts, and settings. This action cannot be undone.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel disabled={isResetting}>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={handleFactoryReset}
                      disabled={isResetting}
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    >
                      {isResetting ? 'Resetting...' : 'Reset everything'}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            }
          />
        </div>
      </div>

      {/* Debug */}
      <div className="space-y-2">
        <button
          onClick={() => setShowDebug(!showDebug)}
          className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <Bug className="h-3.5 w-3.5" />
          <span>{showDebug ? 'Hide' : 'Show'} Debug Tools</span>
        </button>
        {showDebug && (
          <div className="pt-2">
            <DebugTab />
          </div>
        )}
      </div>
    </div>
  )
}
