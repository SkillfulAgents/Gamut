/**
 * The one list of tools the MCP server offers. The server registers each for
 * the request's context. Adding a tool is adding a definition to a module
 * (tool-definition.ts) and the module to this list.
 */
import type { McpServer } from '@modelcontextprotocol/server'
import type { McpCallContext } from './context'
import { MAX_TOOL_NAME_LENGTH, type McpToolDefinition } from './tool-definition'
import { jsonResult, runTool } from './tool-result'
import { guideTools } from './tools/guide-tools'
import { driveTools } from './tools/drive-tools'
import { agentTools } from './tools/agent-tools'
import { sessionTools } from './tools/session-tools'

export const MCP_TOOLS: readonly McpToolDefinition[] = [
  ...guideTools,
  ...driveTools,
  ...agentTools,
  ...sessionTools,
]

export function registerTools(server: McpServer, ctx: McpCallContext, tools: readonly McpToolDefinition[] = MCP_TOOLS): void {
  for (const tool of tools) {
    if (tool.name.length > MAX_TOOL_NAME_LENGTH) throw new Error(`MCP tool name too long: ${tool.name}`)
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        outputSchema: tool.output,
        annotations: { title: tool.title, ...tool.annotations },
      },
      (args: unknown) => runTool(tool.name, async () => jsonResult(await tool.handler(args as never, ctx) as Record<string, unknown>)),
    )
  }
}
