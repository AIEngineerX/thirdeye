import { type ToolContext, getToolByName, tools } from "@thirdeye/agent";

export interface DispatchResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export async function dispatchTool(
  name: string,
  input: unknown,
  ctx: ToolContext,
): Promise<DispatchResult> {
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
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: "tool_error",
            message: e instanceof Error ? e.message : String(e),
          }),
        },
      ],
    };
  }
}

export { tools, getToolByName };
