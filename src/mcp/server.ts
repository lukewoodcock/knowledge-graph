/**
 * The recall MCP server: gives any agent search, open and walk over the
 * graph. It speaks MCP over stdio only, so it has no network listener of
 * its own, and every tool is a thin call to the service's HTTP API.
 *
 * stdout carries MCP messages and nothing else: never console.log here.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { serviceUrl } from '../env';
import { GRAPH_TOOLS, GRAPH_TOOL_NAMES, callGraphTool } from '../graph-tools';

/** Builds the MCP server; `baseUrl` is the service's base URL, as serviceUrl() gives it. */
export function buildMcpServer(baseUrl: string): McpServer {
  const server = new McpServer({ name: 'swarm-kg', version: '1.0.0' });

  for (const name of GRAPH_TOOL_NAMES) {
    const { description, inputSchema } = GRAPH_TOOLS[name];
    server.registerTool(name, { description, inputSchema }, async (args: unknown): Promise<CallToolResult> => {
      const reply = await callGraphTool(baseUrl, name, args);
      return { content: [{ type: 'text', text: reply.text }], ...(reply.isError && { isError: true }) };
    });
  }

  return server;
}

if (require.main === module) {
  const server = buildMcpServer(serviceUrl());
  server.connect(new StdioServerTransport()).catch(err => {
    console.error(`swarm-kg mcp: ${String(err)}`);
    process.exit(1);
  });
}
