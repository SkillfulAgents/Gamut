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

export const EXPECTED_TOOLS: ExpectedTool[] = [
  { name: 'get_guide', title: 'Read the Gamut guide', annotations: READ_ONLY },
  { name: 'list_drives', title: 'List drives', annotations: READ_ONLY },
  { name: 'list_drive_files', title: 'List a drive folder', annotations: READ_ONLY },
  { name: 'read_drive_file', title: 'Read a drive file', annotations: READ_ONLY },
  { name: 'list_agents', title: 'List agents', annotations: READ_ONLY },
  { name: 'list_sessions', title: 'List agent sessions', annotations: READ_ONLY },
  { name: 'read_session', title: 'Read a session transcript', annotations: READ_ONLY },
]

export const EXPECTED_TOOL_NAMES = EXPECTED_TOOLS.map((tool) => tool.name).sort()
