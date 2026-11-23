import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { callHost, textResult, XAgentError } from './host-client'
import { transcriptResultSchema, type TranscriptResult } from './host-response-schemas'
import { oneLine } from '../web/format-results'

type TranscriptLine = TranscriptResult['messages'][number]


function senderLabel(sender: NonNullable<TranscriptLine['sender']>): string {
  if (sender.kind === 'person') return sender.name.trim() ? `${JSON.stringify(sender.name)} (${sender.id})` : sender.id
  if (sender.kind === 'agent') return `agent ${sender.slug}`
  return `via ${oneLine(sender.provider)}`
}

function lineFacts(m: TranscriptLine): string {
  return [
    m.at,
    m.kind,
    m.forked ? 'forked' : undefined,
    m.sender ? senderLabel(m.sender) : undefined,
  ].filter(Boolean).join(' · ')
}

export const getSessionTranscriptTool = tool(
  'get_agent_session_transcript',
  `Read the message transcript of a session belonging to another agent. Returns a status line ('running' | 'idle' | 'awaiting_input') followed by the messages.

Pass limit to get only the most recent N messages (limit: 1 = the agent's final message). Omit limit for the whole view. Prefer a small limit.

By default the view is spoken turns only. Tool calls, tool results, and thinking are collapsed into a stub. Pass full_transcript: true to see today's compact view (tool names and tool results).

Each message header shows when it was written, what a user-role line is when no person wrote it (tool_result, task_notification, compact_summary, injected, system, interrupt, command_output), "forked" for a line copied from the session this one was forked from, and who the app recorded as sending it (a person's name and id, "agent <slug>", or "via <integration>"). A user message with no sender shown has no recorded sender. A line can carry both: its kind says no person wrote the text, its sender says whom the app recorded it under.

If sync=true and the session is currently running, the tool waits up to ~2 minutes for the target agent's turn to complete before returning. If the turn is still in progress after that, it returns the transcript so far with status 'running' — call again with sync=true to keep waiting. Otherwise it returns the current transcript immediately.`,
  {
    slug: z.string().describe('Slug of the target agent (from list_agents)'),
    session_id: z.string().describe('Session ID (from get_agent_sessions)'),
    sync: z.boolean().optional().describe('If true, wait for the session to idle before reading. Default false.'),
    limit: z.number().int().min(1).max(500).optional().describe('Return only the most recent N messages. Omit for the whole view.'),
    full_transcript: z.boolean().optional().describe('If true, include tool calls, tool results, and thinking. Default false.'),
  },
  async (args) => {
    try {
      const data = await callHost('get-transcript', {
        slug: args.slug,
        sessionId: args.session_id,
        sync: args.sync ?? false,
        ...(args.limit ? { limit: args.limit } : {}),
        ...(args.full_transcript ? { fullTranscript: true } : {}),
      }, transcriptResultSchema)
      const shown = data.messages.length
      const header = shown < data.total
        ? `status: ${data.status}\nmessages: showing last ${shown} of ${data.total}`
        : `status: ${data.status}\nmessages: ${data.total}`
      const offset = data.total - shown
      const messageBody = data.messages.length === 0
        ? '(no messages)'
        : data.messages
        .map((m, i) => {
          const tool = m.toolName ? ` [${m.toolName}]` : ''
          const facts = lineFacts(m)
          // Indented so message text cannot pose as another line's header.
          return `--- #${offset + i + 1}${facts ? ` [${facts}]` : ''} ${m.role}${tool} ---\n${m.content.replace(/^--- #/gm, '  --- #')}`
        })
        .join('\n\n')
      const deliveredFiles = data.deliveredFiles.map((file) => {
        const instruction = JSON.stringify({
          slug: args.slug,
          session_id: args.session_id,
          delivery_id: file.deliveryId,
        })
        const description = file.description ? ` — ${file.description}` : ''
        return `- ${JSON.stringify(file.filename)} (${file.sizeBytes} bytes)${description}\n  download_agent_file arguments: ${instruction}`
      })
      const filesBody = deliveredFiles.length > 0
        ? `\n\n--- delivered files ---\n${deliveredFiles.join('\n')}`
        : ''
      return textResult(`${header}\n\n${messageBody}${filesBody}`)
    } catch (error) {
      const msg = error instanceof XAgentError ? error.message : String(error)
      return textResult(`Failed to read transcript: ${msg}`, true)
    }
  },
)
