import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { type ToolContext, tools as agentTools } from "@thirdeye/agent";
import { dispatchTool } from "./dispatch";

export interface ServerOptions {
  name: string;
  version: string;
  ctx: ToolContext;
}

export function createServer(opts: ServerOptions): Server {
  const server = new Server(
    { name: opts.name, version: opts.version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: agentTools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.input_schema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    return await dispatchTool(request.params.name, request.params.arguments ?? {}, opts.ctx);
  });

  return server;
}
