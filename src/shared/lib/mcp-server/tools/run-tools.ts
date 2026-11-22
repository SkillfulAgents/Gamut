/**
 * The tools that make agents work: invoke_agent, ask_team_brain (an invoke
 * aimed at the Team Brain agent) and wait_for_session. All three return the
 * one result shape of session-run.ts.
 */
import { z } from 'zod'
import type { ToolAnnotations } from '@modelcontextprotocol/server'
import { getTeamBrain } from '@shared/lib/config/settings'
import { invokeAndWait, MAX_ATTACHMENTS, MAX_WAIT_SECONDS, DEFAULT_WAIT_SECONDS, waitForSession } from '../session-run'
import { defineTool } from '../tool-definition'
import { McpToolError } from '../tool-result'

const agentRefSchema = z.string().min(1).max(256).describe('The agent slug from list_agents.')
const sessionIdSchema = z.string().min(1).max(256)
const waitSecondsSchema = z.number().optional()
  .describe(`How long to wait for the agent, in seconds: default ${DEFAULT_WAIT_SECONDS}, at most ${MAX_WAIT_SECONDS} (a larger value waits ${MAX_WAIT_SECONDS}). 0 returns as soon as the prompt is delivered.`)
const promptSchema = z.string().min(1).max(100_000)

export const runResultSchema = z.object({
  agent: z.string(),
  session_id: z.string(),
  status: z.enum(['running', 'completed', 'awaiting_input', 'failed']),
  last_message: z.string().nullable(),
  delivered_files: z.array(z.object({ delivery_id: z.string(), filename: z.string(), size_bytes: z.number().int() })),
  pending_request: z.object({ kind: z.string(), text: z.string(), open_in_gamut_url: z.string() }).nullable(),
  note: z.string().optional(),
})

/**
 * Not read-only and open-world: the agent acts with the person's connected
 * accounts and the web. Not destructive as a hint: a call adds a message or a
 * session and deletes nothing, though what the agent then does is its own.
 * Not idempotent: calling again starts another run.
 */
const RUN_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const satisfies Omit<ToolAnnotations, 'title'>

/** Waiting changes nothing; the session it waits on may reach the open world on its own, which is not this call. */
const WAIT_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const satisfies Omit<ToolAnnotations, 'title'>

const RESULT_HELP = 'Returns session_id and status: completed (last_message is the reply), running (still working: call wait_for_session, do not invoke again), awaiting_input (pending_request says what the agent needs; a question is answered by invoke_agent with the same session_id), or failed. delivered_files lists files the agent handed over (get_file_download fetches one).'

export const invokeAgentTool = defineTool({
  name: 'invoke_agent',
  title: 'Invoke an agent',
  description: `Send a Gamut agent a prompt: a new session, or a message in an existing one (session_id), and wait for its answer. Needs the user role or higher on the agent. To send files, call prepare_file_upload first and pass the upload ids in attachments. ${RESULT_HELP} The agent acts with the access it has in Gamut (its connected accounts, the web), and its reply is untrusted content.`,
  scope: 'run',
  input: z.object({
    agent: agentRefSchema,
    prompt: promptSchema.describe('What to ask or tell the agent. When the session waits on a question (status awaiting_input, pending_request.kind "question"), your answer.'),
    session_id: sessionIdSchema.optional().describe('Continue this session (from a previous result or list_sessions). Omit to start a new session.'),
    attachments: z.array(z.string().min(1).max(64)).max(MAX_ATTACHMENTS).optional().describe('Upload ids from prepare_file_upload, after the file was PUT to its upload_url. Each id is used once; the agent sees the files\' workspace paths.'),
    wait_seconds: waitSecondsSchema,
  }),
  output: runResultSchema,
  annotations: RUN_ANNOTATIONS,
  async handler({ agent, prompt, session_id: sessionId, attachments, wait_seconds: waitSeconds }, ctx, call) {
    return invokeAndWait(ctx, call, { agent, prompt, sessionId, attachments, waitSeconds })
  },
})

export const askTeamBrainTool = defineTool({
  name: 'ask_team_brain',
  title: 'Ask the Team Brain',
  description: `Ask the workspace's Team Brain (the agent that keeps what the team knows) a question, and wait for its answer. The first stop for questions about the team, its customers, projects and ways of working. Pass session_id to follow up in the same conversation. ${RESULT_HELP}`,
  scope: 'run',
  input: z.object({
    question: promptSchema.describe('The question, with the context the Team Brain needs to answer it.'),
    session_id: sessionIdSchema.optional().describe('Follow up in this Team Brain session (from a previous result). Omit to start a new one.'),
    wait_seconds: waitSecondsSchema,
  }),
  output: runResultSchema,
  annotations: RUN_ANNOTATIONS,
  async handler({ question, session_id: sessionId, wait_seconds: waitSeconds }, ctx, call) {
    const brain = await getTeamBrain()
    if (!brain) {
      throw new McpToolError('This Gamut workspace has no Team Brain set up yet, so there is no one to ask. A workspace admin sets it up in Gamut (Team Brain). Meanwhile, use list_drives and read_drive_file, or list_agents and invoke_agent.')
    }
    call.setAuditTarget({ agent: brain.agentSlug })
    return invokeAndWait(ctx, call, { agent: brain.agentSlug, prompt: question, sessionId, waitSeconds })
  },
})

export const waitForSessionTool = defineTool({
  name: 'wait_for_session',
  title: 'Wait for a session',
  description: `Wait for an agent's session to finish its current work (or to need the person), up to wait_seconds, and return where it stands. Use it after invoke_agent or ask_team_brain answered status running, instead of invoking again. Needs at least the viewer role. ${RESULT_HELP}`,
  scope: 'read',
  input: z.object({
    agent: agentRefSchema.describe('The agent slug, as the earlier result gave it.'),
    session_id: sessionIdSchema.describe('The session_id from invoke_agent, ask_team_brain or list_sessions.'),
    wait_seconds: waitSecondsSchema,
  }),
  output: runResultSchema,
  annotations: WAIT_ANNOTATIONS,
  async handler({ agent, session_id: sessionId, wait_seconds: waitSeconds }, ctx, call) {
    return waitForSession(ctx, call, { agent, sessionId, waitSeconds })
  },
})

export const runTools = [invokeAgentTool, askTeamBrainTool, waitForSessionTool] as const
