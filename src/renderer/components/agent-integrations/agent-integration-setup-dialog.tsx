import { useState } from 'react'
import { Clock3 } from 'lucide-react'
import { Dialog, DialogContent } from '@renderer/components/ui/dialog'
import { Button } from '@renderer/components/ui/button'
import { useSetChannelDeferred } from '@renderer/hooks/use-finished-setup'
import { INTEGRATION_SETUP_INTROS, IntegrationSetupIntroScreen } from './integration-setup-intro'
import { SetUpLaterContext, type SetUpLater } from './integration-setup-wizard'
import type { IntegrationSetupProps, IntegrationSetupProvider } from './setup-types'

interface AgentIntegrationSetupDialogProps extends Pick<IntegrationSetupProps, 'initial' | 'onIntegrationCreated'> {
  agentSlug: string
  /** Non-null opens the dialog for that provider; null is closed. */
  provider: IntegrationSetupProvider | null
  /** Offer "Set this up later", which saves the provider as a reminder and closes. */
  allowDefer?: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * Shared shell; each provider owns its steps, and the stepper inside sizes the
 * dialog. It opens on the provider's intro, what the integration gets you, and
 * Get started moves on to the steps. Closing it and opening it again starts at
 * the intro.
 */
export function AgentIntegrationSetupDialog({ agentSlug, provider, onOpenChange, initial, onIntegrationCreated, allowDefer }: AgentIntegrationSetupDialogProps) {
  // The provider whose steps are showing; any other one opens on its intro.
  const [started, setStarted] = useState<string | null>(null)
  const close = (open: boolean) => { if (!open) setStarted(null); onOpenChange(open) }
  const intro = provider ? INTEGRATION_SETUP_INTROS[provider.slug] : undefined
  const defer = useSetChannelDeferred(agentSlug)
  // The intro and the steps place it in their own footers, so it never hangs below the dialog.
  const later: SetUpLater | null = allowDefer && provider
    ? { busy: defer.isPending, onClick: () => defer.mutate({ provider: provider.slug, deferred: true }, { onSuccess: () => close(false) }) }
    : null
  return (
    <Dialog open={!!provider} onOpenChange={close}>
      <DialogContent className="w-auto max-w-none max-h-[calc(100dvh-2rem)] gap-0 overflow-y-auto p-0">
        <SetUpLaterContext.Provider value={later}>
          {provider && (intro && started !== provider.slug
            ? <IntegrationSetupIntroScreen agentSlug={agentSlug} intro={intro} onStart={() => setStarted(provider.slug)} />
            : <provider.Setup key={provider.slug} agentSlug={agentSlug} onClose={() => close(false)} initial={initial} onIntegrationCreated={onIntegrationCreated} />)}
        </SetUpLaterContext.Provider>
      </DialogContent>
    </Dialog>
  )
}

/** "Set this up later" for dialogs that aren't the setup steps, such as finishing an installation. */
export function DeferChannelButton({ agentSlug, provider, onClose }: {
  agentSlug: string; provider: IntegrationSetupProvider['slug']; onClose: () => void
}) {
  const save = useSetChannelDeferred(agentSlug)
  return <div className="flex shrink-0 justify-end border-t pt-3">
    <Button type="button" size="sm" variant="outline" disabled={save.isPending}
      onClick={() => save.mutate({ provider, deferred: true }, { onSuccess: onClose })}>
      <Clock3 aria-hidden /> Set this up later
    </Button>
  </div>
}
