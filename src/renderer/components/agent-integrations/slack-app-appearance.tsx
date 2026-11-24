import { useMemo, useState } from 'react'
import { ArrowDownToLine, ExternalLink, Hash, Loader2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { AgentAvatar } from '@renderer/components/agents/agent-avatar/agent-avatar'
import { ORB_ON_GROUND_FILL, avatarSource, orbGround } from '@renderer/components/agents/agent-avatar/avatar-source'
import { DetailCard } from '@renderer/components/triggers/detail-card'
import { useAgent } from '@renderer/hooks/use-agents'
import { saveBlob } from '@renderer/lib/download'
import type { PublicAgentIntegration } from '@shared/lib/agent-integrations/public'
import { publicSlackDelivery } from '@shared/lib/chat-integrations/public'
import { CopyTextButton, SlackAppsLink } from './slack-delivery-card'
import { IntegrationSetupAside } from './integration-setup-layout'
import type { IntegrationSetupWizardStep } from './integration-setup-wizard'
import { agentAppIconSvg } from './agent-app-icon'
import { slackAppIcon, slackAppIdentity, type SlackAppAgent } from './slack-app-identity'

const where = <strong className="font-medium">Basic Information → Display Information</strong>

/** Downloads the agent's avatar as a Slack app icon. `size="step"` is the setup's own step, where it is the one thing to do. */
export function SlackAppIconButton({ agent, size = 'compact' }: { agent: SlackAppAgent; size?: 'compact' | 'step' }) {
  const [state, setState] = useState<'idle' | 'busy' | 'failed'>('idle')
  if (!agent.avatar) return null
  const download = async () => {
    setState('busy')
    try {
      saveBlob(await slackAppIcon(agent), `${agent.name.trim() || 'Agent'} icon.png`)
      setState('idle')
    } catch {
      setState('failed')
    }
  }
  return <span className="inline-flex flex-wrap items-center gap-2">
    <Button type="button" variant="outline" size="sm" className={size === 'compact' ? 'h-7 gap-1.5 px-2 text-xs' : 'gap-2'} disabled={state === 'busy'} onClick={() => void download()} data-testid="slack-app-icon-download">
      {state === 'busy' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowDownToLine aria-hidden="true" className="h-3.5 w-3.5" />}Download icon
    </Button>
    {state === 'failed' && <span role="alert" className="text-xs text-destructive">Couldn’t make the icon.</span>}
  </span>
}

/**
 * The picture the download makes, small: the same SVG the PNG is rasterised
 * from, so what is shown is what is saved.
 */
function SlackAppIconThumbnail({ agent }: { agent: SlackAppAgent }) {
  const src = useMemo(() => agent.avatar ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(agentAppIconSvg(agent, 128))}` : null, [agent])
  if (!src) return null
  return <img src={src} alt="The icon that downloads" className="size-8 shrink-0 rounded-md ring-1 ring-black/5 dark:ring-white/10" data-testid="slack-app-icon-thumbnail" />
}

function ColorSwatch({ color }: { color: string }) {
  return <span className="inline-flex items-center gap-2">
    <span className="inline-flex items-center gap-1.5 font-mono text-xs"><span className="h-3.5 w-3.5 rounded-sm border" style={{ background: color }} />{color}</span>
    <CopyTextButton text={color} label="Copy color" />
  </span>
}

/**
 * On the card that finishes a setup left half done, what a manifest can't
 * set: the icon. Only for an agent with an avatar. (The setup itself has a
 * step for it, `slackAppIconStep`.)
 */
export function SlackAppIconAside({ agent, withColor = false }: { agent: SlackAppAgent; withColor?: boolean }) {
  const { backgroundColor } = slackAppIdentity(agent)
  if (!agent.avatar) return null
  return <IntegrationSetupAside action={<span className="inline-flex flex-wrap items-center gap-3">
    <SlackAppIconButton agent={agent} />
    {withColor && backgroundColor && <ColorSwatch color={backgroundColor} />}
  </span>}>
    Optional: to give the app this agent’s face, upload its icon{withColor && backgroundColor ? ' and set the background color' : ''} under {where}.
  </IntegrationSetupAside>
}

/**
 * The icon as it will sit beside this agent's messages in Slack: the orb on its
 * pale ground, the same picture the download makes.
 *
 * Drawn as a picture, not a control, like the sender's preview in the inbox
 * setup: a tinted, borderless panel holding a small Slack window that floats
 * on a shadow and runs off the panel's bottom edge.
 */
function SlackIconPreview({ agent, name }: { agent: SlackAppAgent & { avatar: NonNullable<SlackAppAgent['avatar']> }; name: string }) {
  const size = 36
  return (
    <figure className="overflow-hidden rounded-xl bg-muted/70 px-5 pt-3.5 text-left text-xs dark:bg-muted/40">
      <figcaption className="pb-3 text-[11px] text-muted-foreground">Preview · How it shows in Slack</figcaption>
      <div className="-mb-4 overflow-hidden rounded-lg border bg-background shadow-md">
        <div className="flex items-center gap-1 border-b px-3 py-1.5 text-[11px] text-muted-foreground">
          <Hash aria-hidden="true" className="h-3 w-3" />
          support
        </div>
        <div className="flex items-start gap-2.5 bg-muted/40 px-3 py-2.5">
          <span className="grid shrink-0 place-items-center rounded-lg" style={{ width: size, height: size, background: orbGround(avatarSource(agent.avatar).orb) }} data-testid="slack-app-icon-preview">
            <AgentAvatar agent={agent} size={Math.round(size * ORB_ON_GROUND_FILL)} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline gap-1.5">
              <span className="truncate font-medium text-foreground">{name}</span>
              <span className="shrink-0 rounded-[3px] bg-muted px-1 py-px text-[9px] font-medium uppercase tracking-wide text-muted-foreground">App</span>
              <span className="shrink-0 text-[11px] text-muted-foreground">9:41 AM</span>
            </span>
            <span className="block truncate text-muted-foreground">Found it: an expired card token. Fix is in review.</span>
          </span>
        </div>
        <div aria-hidden="true" className="flex items-start gap-2.5 px-3 pb-6 pt-2.5 opacity-40">
          <span className="grid shrink-0 place-items-center rounded-lg bg-[#7c5cff] text-[13px] text-white" style={{ width: size, height: size }}>D</span>
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline gap-1.5"><span className="font-medium text-foreground">Dana</span><span className="text-[11px] text-muted-foreground">9:42 AM</span></span>
            <span className="block truncate text-muted-foreground">Thank you, that was fast.</span>
          </span>
        </div>
      </div>
    </figure>
  )
}

/**
 * The setup's step for what a manifest can't set: the icon, and, for an app
 * made without the manifest, its colour. Both are set on Slack's Basic
 * Information page, so the step follows the one that copies a secret from it.
 * No step for an agent without an avatar: there is nothing to download.
 */
export function slackAppIconStep(agent: SlackAppAgent | undefined, { name, withColor = false }: { name?: string | null; withColor?: boolean } = {}): IntegrationSetupWizardStep | null {
  if (!agent?.avatar) return null
  const identity = slackAppIdentity(agent, name)
  const color = withColor ? identity.backgroundColor : undefined
  return {
    label: 'Add the icon',
    subtitle: <>
      <span className="text-foreground">Give this agent a profile photo in Slack.</span><br />
      Download the icon, then upload it under {where}{color ? ' and set the background color' : ''}. You can skip this and add it later.
    </>,
    content: <>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="inline-flex items-center gap-2.5">
          <SlackAppIconThumbnail agent={agent} />
          <SlackAppIconButton agent={agent} size="step" />
        </span>
        {color && <ColorSwatch color={color} />}
      </div>
      <SlackIconPreview agent={{ ...agent, avatar: agent.avatar }} name={identity.name} />
    </>,
  }
}

/**
 * A connected Slack app's look, to match it to its agent by hand: the
 * manifest set its name and colour only when the app was created, and never
 * an icon.
 */
export function SlackAppAppearanceCard({ integration }: { integration: PublicAgentIntegration }) {
  const slack = publicSlackDelivery(integration)
  const { data: agent } = useAgent(integration.agentSlug)
  // Before the app is connected, its setup carries the icon; an app a team directory created has its own card.
  if (!slack?.botTokenSaved || integration.provisionedApp) return null
  const { backgroundColor } = agent ? slackAppIdentity(agent) : { backgroundColor: undefined }
  // Slack has no API that lets a bot rename itself: an app made by hand is renamed in its settings.
  const settings = slack.appId ? `https://api.slack.com/apps/${slack.appId}` : null
  return <DetailCard label="Name, Icon & Color">
    <div className="space-y-3" data-testid="slack-app-appearance">
      {settings && (
        <p className="text-xs text-muted-foreground">
          To rename this app or change its @handle, open{' '}
          <a className="inline-flex items-center gap-1 text-primary hover:underline" href={settings} target="_blank" rel="noreferrer" data-testid="slack-rename-in-slack">its settings in Slack<ExternalLink className="h-3 w-3" /></a>
          {' '}and edit {where} and App Home.
        </p>
      )}
      {agent?.avatar && <>
        <p className="text-xs text-muted-foreground">To show this agent in Slack, open its app at <SlackAppsLink />, then in {where} upload the icon and set the background color.</p>
        <div className="flex flex-wrap items-center gap-3">
          <SlackAppIconButton agent={agent} />
          {backgroundColor && <ColorSwatch color={backgroundColor} />}
        </div>
      </>}
    </div>
  </DetailCard>
}
