/**
 * The tools the server must offer, exactly: names, titles and annotations.
 * A PR that adds a tool adds it here, and every suite (SDK clients, Claude
 * Code, Codex) checks the same list.
 */
export interface ExpectedTool {
  name: string
  title: string
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean }
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
/** Makes an agent act: with its connected accounts and the web, so open world; it deletes nothing. */
const RUN = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
const UPLOAD = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }

export const EXPECTED_TOOLS: ExpectedTool[] = [
  { name: 'get_guide', title: 'Read the Gamut guide', annotations: READ_ONLY },
  { name: 'list_drives', title: 'List drives', annotations: READ_ONLY },
  { name: 'list_drive_files', title: 'List a drive folder', annotations: READ_ONLY },
  { name: 'read_drive_file', title: 'Read a drive file', annotations: READ_ONLY },
  { name: 'list_agents', title: 'List agents', annotations: READ_ONLY },
  { name: 'list_sessions', title: 'List agent sessions', annotations: READ_ONLY },
  { name: 'read_session', title: 'Read a session transcript', annotations: READ_ONLY },
  { name: 'invoke_agent', title: 'Invoke an agent', annotations: RUN },
  { name: 'ask_team_brain', title: 'Ask the Team Brain', annotations: RUN },
  { name: 'wait_for_session', title: 'Wait for a session', annotations: READ_ONLY },
  { name: 'prepare_file_upload', title: 'Prepare a file upload', annotations: UPLOAD },
  { name: 'get_file_download', title: 'Get a file download link', annotations: READ_ONLY },
]

export const EXPECTED_TOOL_NAMES = EXPECTED_TOOLS.map((tool) => tool.name).sort()
