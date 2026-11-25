import { useCallback, useEffect, useRef } from 'react'
import { useRouter, useSearch } from '@tanstack/react-router'
import { ChevronLeft } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { CreateAgentScreen } from '@renderer/components/wizard/create-agent-step'
import { useFileAgentIntoSection } from '@renderer/hooks/use-file-agent-into-section'
import { useAnalyticsTracking } from '@renderer/context/analytics-context'
import { creationDraftKey, readCreationDraft } from './creation-draft'

export function NewAgentPage() {
  const router = useRouter()
  const { from, section, surface } = useSearch({ from: '/new-agent' })
  const fileIntoSection = useFileAgentIntoSection()
  const { track } = useAnalyticsTracking()

  // `agent_created` is sent once a name is confirmed, so this is the only count of opens that ended before one.
  // A refresh mid-flow resumes its draft on the same history entry: that is not a second open.
  const opened = useRef(false)
  useEffect(() => {
    if (opened.current) return
    opened.current = true
    if (readCreationDraft(creationDraftKey())) return
    track('agent_creation_opened', { ...(surface ? { surface } : {}) })
  }, [track, surface])

  const close = useCallback(() => {
    // `from` was open-redirect-validated by the route's validateSearch. Push
    // the raw path+search so we land exactly where the button was pressed.
    router.history.push(from ?? '/')
  }, [router, from])

  const handleAgentCreated = useCallback(
    ({ slug }: { slug: string }) => fileIntoSection(slug, section),
    [fileIntoSection, section],
  )

  return (
    <CreateAgentScreen
      data-testid="new-agent-page"
      nameTitle="Name your new AI teammate"
      surface={surface}
      onIdentityCreated={handleAgentCreated}
      onClose={close}
      footer={(flow) => (
        // A step back while there is one; from the first step it leaves.
        <Button
          variant="outline"
          onClick={() => { if (!flow.back()) close() }}
          data-testid="new-agent-back"
        >
          <ChevronLeft className="h-4 w-4 mr-1" />
          Back
        </Button>
      )}
    />
  )
}
