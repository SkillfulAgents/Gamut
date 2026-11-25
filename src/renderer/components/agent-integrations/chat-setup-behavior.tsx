import type { ChatProvider } from '@shared/lib/chat-integrations/config-schema'
import { DEFAULT_SESSION_TIMEOUT_HOURS } from '@shared/lib/agent-integrations/public'
import { IntegrationSetupToggle } from './integration-setup-layout'
import { SessionTimeoutSelect } from './integration-settings-controls'

/** The step of toggles every chat setup has, named and introduced the same way in each. */
export const SETTINGS_STEP_LABEL = 'Review settings'
export const SETTINGS_STEP_SUBTITLE = 'You can change these later on the integration’s page.'

/** How a new chat integration behaves, chosen during setup. */
export interface ChatSetupBehaviorValue {
  showToolCalls: boolean
  sessionTimeout: number | null
  onlyMentioned: boolean
  answerInThread: boolean
  newSessionPerThread: boolean
}

export const DEFAULT_CHAT_SETUP_BEHAVIOR: ChatSetupBehaviorValue = {
  showToolCalls: false, sessionTimeout: DEFAULT_SESSION_TIMEOUT_HOURS, onlyMentioned: true, answerInThread: true, newSessionPerThread: true,
}

/** Slack's channel behavior, as its stored config spells it. */
export function slackBehaviorConfig(value: ChatSetupBehaviorValue): Record<string, boolean> {
  return {
    onlyMentioned: value.onlyMentioned,
    answerInThread: value.answerInThread,
    newSessionPerThread: value.answerInThread && value.newSessionPerThread,
  }
}

export function ChatSetupBehavior({ provider, value, onChange, disabled }: {
  provider: ChatProvider
  value: ChatSetupBehaviorValue
  disabled?: boolean
  onChange: (value: ChatSetupBehaviorValue) => void
}) {
  const set = (change: Partial<ChatSetupBehaviorValue>) => onChange({ ...value, ...change })
  const row = 'min-h-11 px-3.5 py-2.5'
  return (
    <div className="divide-y divide-border overflow-hidden rounded-item border">
      <IntegrationSetupToggle className={row} id="setup-show-tool-calls" label="Show tool calls in chat"
        description="Posts a line for each tool it uses, so you can see it working."
        checked={value.showToolCalls} disabled={disabled} onCheckedChange={showToolCalls => set({ showToolCalls })} />
      <SessionTimeoutSelect id="setup-session-timeout" layout="setup" disabled={disabled}
        value={value.sessionTimeout} onCommit={sessionTimeout => set({ sessionTimeout })} />

      {provider === 'slack' && <>
        <IntegrationSetupToggle className={row} id="setup-only-mentioned" label="Only respond when @mentioned"
          checked={value.onlyMentioned} disabled={disabled} onCheckedChange={onlyMentioned => set({ onlyMentioned })} />
        <IntegrationSetupToggle className={row} id="setup-answer-thread" label="Reply in thread (recommended)"
          description="Replies under the message, not in the channel." checked={value.answerInThread} disabled={disabled}
          onCheckedChange={answerInThread => set({ answerInThread, newSessionPerThread: answerInThread && value.newSessionPerThread })} />
        {value.answerInThread && <IntegrationSetupToggle className={row} id="setup-session-per-thread" label="Separate conversation per thread (recommended)"
          description="Each thread stays separate, so requests don’t mix." checked={value.newSessionPerThread}
          disabled={disabled} onCheckedChange={newSessionPerThread => set({ newSessionPerThread })} />}
      </>}
    </div>
  )
}
