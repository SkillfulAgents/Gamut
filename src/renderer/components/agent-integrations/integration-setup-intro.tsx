import { useContext, type ReactNode } from 'react'
import { AtSign, GitPullRequest, Paperclip } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { DialogDescription, DialogTitle } from '@renderer/components/ui/dialog'
import { DisplacedDotField } from '@renderer/components/ui/displaced-dot-field'
import { ServiceIcon } from '@renderer/components/ui/service-icon'
import { AgentAvatar } from '@renderer/components/agents/agent-avatar/agent-avatar'
import { useAgent } from '@renderer/hooks/use-agents'
import type { ApiAgent } from '@shared/lib/types/api'
import { cn } from '@shared/lib/utils/cn'
import { SETUP_PRIMARY_BUTTON, SetUpLaterButton, SetUpLaterContext } from './integration-setup-wizard'
import danaPhoto from '@renderer/assets/integration-intros/meeting-dana.jpg'
import samPhoto from '@renderer/assets/integration-intros/meeting-sam.jpg'

export type IntroAgent = Pick<ApiAgent, 'slug' | 'name' | 'avatar'>

/** What an integration's setup opens on: the picture, a line on what it gets you, one button. */
export interface IntegrationSetupIntro {
  headline: string
  /** The headline's second line, quieter: its own sentence, or the end of the headline's. */
  subline: string
  body: string
  /** The integration at work, in miniature, with this agent in it. */
  Preview: (props: { agent: IntroAgent }) => ReactNode
}

/**
 * The first screen of an integration's setup, laid out like the Team Brain
 * landing page at the size of the setup dialog: the dot grid behind a small
 * picture of the integration at work, a two-line headline, a sentence on what
 * it does, and Get started where every step's Next sits.
 */
export function IntegrationSetupIntroScreen({ agentSlug, intro, onStart }: {
  agentSlug: string
  intro: IntegrationSetupIntro
  onStart: () => void
}) {
  const { data } = useAgent(agentSlug)
  const agent: IntroAgent = { slug: agentSlug, name: data?.name || 'Agent', avatar: data?.avatar ?? null }
  const { Preview } = intro
  const later = useContext(SetUpLaterContext)
  return (
    <div className="flex min-h-[26rem] w-[min(40rem,calc(100vw-2rem))] flex-col" data-testid="integration-setup-intro">
      {/*
        The picture sits low in a fixed-height band and runs off its bottom edge, fading out
        there, so it reads as rising into view from below the copy. The band is a shade of grey
        (darker at the top, where the picture's top edge is) and the picture is white on a deep
        soft shadow, so the picture is plainly the thing in front.
      */}
      <div className="relative flex h-52 justify-center overflow-hidden bg-gradient-to-b from-[#e9e9e7] to-[#f4f4f3] px-10 pt-10 dark:from-black dark:to-[#0d0d0d] max-sm:h-40 max-sm:px-6 max-sm:pt-6">
        {/* The Team Brain landing's dot grid, finer and fainter so it stays behind the picture, fading out toward the copy. */}
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 [mask-image:linear-gradient(to_bottom,#000_55%,transparent)]">
          <DisplacedDotField intro alpha={0.13} spacing={9} dotRadius={0.55} />
        </div>
        {/*
          The fade spans the band, not the card, so every card dissolves the same way at its bottom edge.
          The mask cuts at this box, so it is wider than the card by the room its shadow needs.
        */}
        <div className="relative h-full w-full max-w-[27rem] px-10 duration-500 animate-in fade-in slide-in-from-bottom-3 [mask-image:linear-gradient(to_bottom,#000_55%,transparent_100%)] motion-reduce:animate-none max-sm:px-3">
          <Preview agent={agent} />
        </div>
      </div>
      <div className="flex flex-1 flex-col px-6 pb-6 pt-9 max-sm:px-5 max-sm:pb-5 max-sm:pt-6">
        {/* No mark beside the headline: the picture above carries the provider's, in its window's title. */}
        <DialogTitle className="text-[22px] font-normal leading-[1.32] tracking-tight max-sm:text-lg">
          {/* The space keeps the two lines apart when they're read out as one name. */}
          <span className="block">{intro.headline}</span>{' '}
          <span className="block text-muted-foreground">{intro.subline}</span>
        </DialogTitle>
        <DialogDescription className="mt-3 max-w-md text-sm text-muted-foreground/75">{intro.body}</DialogDescription>
        {/* Where Next sits on every step after it. */}
        <footer className="mt-auto flex justify-end gap-2 pt-6 max-sm:pt-5">
          {later && <SetUpLaterButton later={later} />}
          <Button type="button" size="sm" className={SETUP_PRIMARY_BUTTON} onClick={onStart} data-testid="integration-setup-start">Get started</Button>
        </footer>
      </div>
    </div>
  )
}

// ── The pictures ─────────────────────────────────────────────────────────────

/** The agent's face, or its initial where it has none. Also drawn in a step's own preview, e.g. the name in a call. */
export function Face({ agent, size = 20 }: { agent: IntroAgent; size?: number }) {
  if (agent.avatar) return <span className="shrink-0"><AgentAvatar agent={agent} size={size} /></span>
  return <span className="grid shrink-0 place-items-center rounded-full bg-foreground text-background" style={{ width: size, height: size, fontSize: Math.max(10, size * 0.45) }}>{agent.name.slice(0, 1).toUpperCase()}</span>
}

function Person({ initial, className }: { initial: string; className: string }) {
  return <span className={cn('grid size-5 shrink-0 place-items-center rounded-full text-[10px] text-white', className)}>{initial}</span>
}

/** A window of another app: its icon and title along the top, then whatever happens inside. Taller than the band it sits in, so it always runs off the bottom. */
function Frame({ provider, title, iconClassName, children }: { provider: string; title: string; iconClassName?: string; children: ReactNode }) {
  return (
    <div className="min-h-[13rem] overflow-hidden rounded-xl border border-black/[0.07] bg-white text-left text-[12px]/[17px] shadow-[0_18px_40px_-12px_rgba(0,0,0,0.28),0_3px_8px_-2px_rgba(0,0,0,0.10)] dark:border-white/10 dark:bg-[#1c1c1c] dark:shadow-[0_18px_40px_-12px_rgba(0,0,0,0.9)]">
      <div className="flex items-center gap-1.5 border-b px-3 py-2 text-[11px] text-muted-foreground">
        <ServiceIcon slug={provider} fallback="mcp" className={cn('h-3.5 w-3.5', iconClassName)} />
        {title}
      </div>
      <div className="space-y-2.5 p-3">{children}</div>
    </div>
  )
}

/** How Slack, GitHub and Linear mark an account that isn't a person's: the agent shows as itself. */
function OwnTag({ children }: { children: ReactNode }) {
  return <span className="ml-1 rounded-[3px] bg-muted px-1 py-px align-[1px] text-[9px] font-medium uppercase tracking-wide text-muted-foreground">{children}</span>
}

function Bubble({ mine, className, children }: { mine?: boolean; className?: string; children: ReactNode }) {
  return <div className={cn('w-fit max-w-[85%] rounded-2xl px-3 py-1.5', mine ? 'ml-auto rounded-br-md' : 'rounded-bl-md bg-muted', className)}>{children}</div>
}

function TelegramPreview({ agent }: { agent: IntroAgent }) {
  return (
    <Frame provider="telegram" title={agent.name}>
      <Bubble mine className="bg-[#3390ec] text-white">What’s on my plate today?</Bubble>
      <div className="flex items-end gap-1.5">
        <Face agent={agent} />
        <Bubble>Three calls and the Q3 report. I drafted the report; it’s ready for a look.</Bubble>
      </div>
    </Frame>
  )
}

function IMessagePreview({ agent }: { agent: IntroAgent }) {
  return (
    <Frame provider="imessage" title={agent.name}>
      <Bubble mine className="bg-[#0a84ff] text-white">Running late. Can you push my 3pm?</Bubble>
      <div className="flex items-end gap-1.5">
        <Face agent={agent} />
        <Bubble>Done. Moved to 3:30 and let Sam know.</Bubble>
      </div>
    </Frame>
  )
}

function SlackPreview({ agent }: { agent: IntroAgent }) {
  return (
    <Frame provider="slack" title="# support">
      <div className="flex gap-2">
        <Person initial="D" className="bg-[#7c5cff]" />
        <div><span className="font-medium">Dana</span><p><span className="rounded bg-[#e8f5fa] px-0.5 text-[#1264a3] dark:bg-[#1264a3]/25 dark:text-[#5fb2e6]">@{agent.name}</span> can you check why checkout is failing?</p></div>
      </div>
      <div className="ml-7 flex gap-2 border-l-2 pl-2.5">
        <Face agent={agent} />
        <div><span className="font-medium">{agent.name}</span><OwnTag>App</OwnTag><p>Found it: an expired card token. Fix is in review.</p></div>
      </div>
    </Frame>
  )
}

function TeamsPreview({ agent }: { agent: IntroAgent }) {
  return (
    <Frame provider="teams" title="Microsoft Teams · General">
      <Bubble mine className="rounded-lg bg-[#e8e8fa] text-[#333357] dark:bg-[#414166] dark:text-white">
        <strong>@{agent.name}</strong> what did we decide about the launch?
      </Bubble>
      <div className="flex items-start gap-2">
        <Face agent={agent} />
        <div className="min-w-0">
          <p className="text-[11px] text-muted-foreground">{agent.name}</p>
          <Bubble className="max-w-full rounded-lg">Friday is the launch date. Sam is writing the announcement.</Bubble>
        </div>
      </div>
    </Frame>
  )
}

function EmailPreview({ agent }: { agent: IntroAgent }) {
  const address = `${agent.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'agent'}@acme.ongamut.so`
  return (
    <Frame provider="platform-email" title="Inbox">
      <div className="space-y-0.5">
        <p className="text-[11px] text-muted-foreground">To {address}</p>
        <p className="font-medium">Can you pull together the March invoices?</p>
      </div>
      <div className="flex gap-2 rounded-lg bg-muted px-2.5 py-2">
        <Face agent={agent} />
        <div className="min-w-0">
          <p>Here they are, totalled by client.</p>
          <p className="mt-1 inline-flex items-center gap-1 text-[11px] text-muted-foreground"><Paperclip className="size-3" aria-hidden="true" />march-invoices.xlsx</p>
        </div>
      </div>
    </Frame>
  )
}

function GitHubPreview({ agent }: { agent: IntroAgent }) {
  return (
    <Frame provider="github" title="Flaky checkout test #212" iconClassName="dark:invert">
      <div className="flex gap-2">
        <Person initial="S" className="bg-[#2da44e]" />
        <p><span className="font-medium">@{handle(agent)}</span> can you take a look at this?</p>
      </div>
      <div className="flex items-center gap-2 rounded-lg border px-2.5 py-2">
        <Face agent={agent} />
        <GitPullRequest className="size-3.5 shrink-0 text-[#8250df]" aria-hidden="true" />
        <p className="min-w-0 truncate"><span className="font-medium">{handle(agent)}[bot]</span> opened #213</p>
      </div>
    </Frame>
  )
}

/** The agent's name as an account handle. */
function handle(agent: IntroAgent) {
  return agent.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'agent'
}

function LinearPreview({ agent }: { agent: IntroAgent }) {
  return (
    <Frame provider="linear" title="ENG-482 Login redirect loops on Safari" iconClassName="dark:invert">
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground">Assignee</span>
        <span className="flex items-center gap-1.5"><Face agent={agent} size={16} />{agent.name}<OwnTag>App</OwnTag></span>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground">Status</span>
        <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-full border-2 border-[#f2c94c] border-r-transparent" aria-hidden="true" />In Progress</span>
      </div>
      <div className="flex gap-2 border-t pt-2.5">
        <Face agent={agent} size={16} />
        <p>Reproduced it. A cookie check runs twice on Safari; fix coming.</p>
      </div>
    </Frame>
  )
}

function MeetingsPreview({ agent }: { agent: IntroAgent }) {
  return (
    <Frame provider="recall" title="Weekly sync">
      <div className="grid grid-cols-3 gap-1.5">
        {[{ name: 'Dana', photo: danaPhoto }, { name: 'Sam', photo: samPhoto }].map(({ name, photo }) => (
          <div key={name} className="relative aspect-[4/3] overflow-hidden rounded-lg bg-muted">
            <img src={photo} alt="" className="size-full object-cover" />
            <span className="absolute bottom-1 left-1 rounded bg-black/55 px-1 text-[10px] text-white">{name}</span>
          </div>
        ))}
        {/* The agent's tile, named like the people's: white on a dark tag in its corner, one line however long the name. The ring says it's the one speaking. */}
        <div className="relative flex aspect-[4/3] items-center justify-center rounded-lg bg-muted pb-2.5 ring-2 ring-brand">
          <Face agent={agent} size={34} />
          <span className="absolute bottom-1 left-1 max-w-[calc(100%-0.5rem)] truncate rounded bg-black/55 px-1 text-[10px] text-white">{agent.name}</span>
        </div>
      </div>
      <p className="flex items-start gap-1.5 text-muted-foreground"><AtSign className="mt-0.5 size-3 shrink-0" aria-hidden="true" />Action items: Dana sends the deck, Sam books the venue.</p>
    </Frame>
  )
}

/** Each integration's first screen, by provider. */
export const INTEGRATION_SETUP_INTROS: Record<string, IntegrationSetupIntro> = {
  'platform-email': {
    headline: 'Give this agent its own inbox.',
    subline: 'Email it like a teammate.',
    body: 'Forward a thread, ask for a summary or have it reply for you. It answers from its own address, and you choose who it talks to.',
    Preview: EmailPreview,
  },
  telegram: {
    headline: 'Chat with this agent in Telegram.',
    subline: 'From your phone or desktop.',
    body: 'Message it the way you message anyone. It gets a bot of its own and works with the same tools it has here.',
    Preview: TelegramPreview,
  },
  slack: {
    headline: 'Add this agent to Slack',
    subline: 'as a teammate.',
    body: 'Your team can DM it or mention it in any channel. Everything it posts comes from its own app, not your account.',
    Preview: SlackPreview,
  },
  teams: {
    headline: 'Give this agent its own Teams app.',
    subline: 'Chat directly or mention it in a channel.',
    body: 'Connect a bot from your Microsoft tenant. Your team can message the agent by name and bring it into a conversation with an @mention.',
    Preview: TeamsPreview,
  },
  imessage: {
    headline: 'Text this agent from your phone.',
    subline: 'Nothing to install.',
    body: 'Message it like any other contact. It replies by text and can send you files and updates while you’re away from your desk.',
    Preview: IMessagePreview,
  },
  github: {
    headline: 'Add this agent to GitHub',
    subline: 'as a teammate.',
    body: 'Mention it on an issue or pull request to put it to work. It sees only the repositories you choose, and it comments and opens pull requests as itself, not as you.',
    Preview: GitHubPreview,
  },
  linear: {
    headline: 'Add this agent to Linear',
    subline: 'as a teammate.',
    body: 'Assign it an issue or mention it in a comment to put it to work. Every update it makes shows under its own name, not yours.',
    Preview: LinearPreview,
  },
  recall: {
    headline: 'Bring this agent to your meetings.',
    subline: 'Zoom, Google Meet and Microsoft Teams.',
    body: 'It joins as a participant, answers when asked, and keeps notes and action items you can come back to.',
    Preview: MeetingsPreview,
  },
}
