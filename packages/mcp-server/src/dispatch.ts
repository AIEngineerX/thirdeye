import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type ToolContext, getToolByName, tools } from "@thirdeye/agent";

export type DispatchResult = CallToolResult;

// F5: per-process tool-call cap. Without it, an MCP client (Claude Desktop,
// Cursor) running in a loop could keep dispatching tool calls until the
// operator notices and disables the server. The cap is per-process (resets
// on bin.ts restart) which matches the actual threat model — a single
// runaway session burning credits within one Claude Desktop launch.
// Default value of 200 is well above any single-conversation legitimate
// use (a chat exploring 10 wallets calls maybe 30 tools) and far below
// what a runaway loop could rack up. Operators with heavier workflows can
// raise via MCP_MAX_TOOL_CALLS_PER_SESSION env var on the process.
const DEFAULT_MAX_TOOL_CALLS_PER_SESSION = 200;
let dispatchCount = 0;

function maxToolCalls(): number {
  const raw = process.env.MCP_MAX_TOOL_CALLS_PER_SESSION;
  if (!raw) return DEFAULT_MAX_TOOL_CALLS_PER_SESSION;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_TOOL_CALLS_PER_SESSION;
}

// Test-only helper: reset the per-process counter between tests so they
// don't accumulate.
export function _resetMcpDispatchCount(): void {
  dispatchCount = 0;
}

export async function dispatchTool(
  name: string,
  input: unknown,
  ctx: ToolContext,
): Promise<DispatchResult> {
  const cap = maxToolCalls();
  dispatchCount++;
  if (dispatchCount > cap) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: "session_tool_cap_reached",
            message: `MCP session reached ${cap} tool calls — restart the MCP server (Claude Desktop) to reset. Adjust via MCP_MAX_TOOL_CALLS_PER_SESSION env var.`,
          }),
        },
      ],
    };
  }

  const tool = getToolByName(name);
  if (!tool) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: "unknown_tool",
            message: `tool "${name}" is not in the registry`,
            available: tools.map((t) => t.name),
          }),
        },
      ],
    };
  }

  try {
    const out = await tool.handler(input, ctx);
    return {
      content: [{ type: "text", text: JSON.stringify(out) }],
    };
  } catch (e) {
    // F2: raw e.message could leak DB error fragments (Postgres reports
    // include schema/column names; library asserts include partial data).
    // Log server-side for diagnostics; return a generic message to the
    // LLM client.
    console.error(`[mcp-dispatch] ${name} failed`, e);
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: "tool_error",
            message: `tool ${name} failed — see server logs`,
          }),
        },
      ],
    };
  }
}

export { tools, getToolByName };
