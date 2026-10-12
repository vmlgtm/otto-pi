import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { ToolRegistration } from "@earendil-works/pi-durable";

export interface McpServerConfig {
  url: string;
  transport?: "http" | "sse";
  headers?: Record<string, string>;
}

export type McpServersConfig =
  | Record<string, McpServerConfig | string>
  | Array<{ name: string; url: string; transport?: "http" | "sse"; headers?: Record<string, string> }>;

/**
 * Normalizes MCP server definitions from env.MCP_SERVERS (string JSON or object).
 */
export function parseMcpServersConfig(
  raw?: string | McpServersConfig
): Map<string, McpServerConfig> {
  const result = new Map<string, McpServerConfig>();
  if (!raw) return result;

  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.warn("Failed to parse MCP_SERVERS JSON config:", e);
      return result;
    }
  }

  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (item && typeof item === "object" && typeof item.name === "string" && typeof item.url === "string") {
        result.set(item.name, {
          url: item.url,
          transport: item.transport,
          headers: item.headers
        });
      }
    }
  } else if (parsed && typeof parsed === "object") {
    for (const [name, cfg] of Object.entries(parsed)) {
      if (typeof cfg === "string") {
        result.set(name, { url: cfg });
      } else if (cfg && typeof cfg === "object" && typeof (cfg as any).url === "string") {
        result.set(name, {
          url: (cfg as any).url,
          transport: (cfg as any).transport,
          headers: (cfg as any).headers
        });
      }
    }
  }

  return result;
}

/**
 * Connects to a remote MCP server and converts its tools into namespaced Pi ToolRegistrations.
 */
export async function connectMcpServer(
  serverName: string,
  config: McpServerConfig
): Promise<{ client: Client; tools: ToolRegistration[] }> {
  const client = new Client(
    { name: `otto-pi-${serverName}`, version: "1.0.0" },
    { capabilities: {} }
  );

  const url = new URL(config.url);
  const isSse = config.transport === "sse" || url.pathname.endsWith("/sse");

  const transport = isSse
    ? new SSEClientTransport(url, {
        requestInit: config.headers ? { headers: config.headers } : undefined
      })
    : new StreamableHTTPClientTransport(url, {
        requestInit: config.headers ? { headers: config.headers } : undefined
      });

  await client.connect(transport);
  const tools = await adaptMcpClient(serverName, client);
  return { client, tools };
}

/**
 * Discovers tools on an initialized MCP Client and translates them into Pi ToolRegistrations.
 */
export async function adaptMcpClient(
  serverName: string,
  client: Client
): Promise<ToolRegistration[]> {
  const { tools: mcpTools } = await client.listTools();

  return mcpTools.map((mcpTool): ToolRegistration => {
    // Namespace tool as ${serverName}__${tool.name}
    const namespacedName = `${serverName}__${mcpTool.name}`;

    return {
      name: namespacedName,
      description: mcpTool.description ?? `MCP Tool ${mcpTool.name} from ${serverName}`,
      parameters: mcpTool.inputSchema as any,
      replay: "unsafe",
      async execute(args) {
        try {
          const res = await client.callTool({
            name: mcpTool.name,
            arguments: (args ?? {}) as Record<string, unknown>
          });

          // Format content into Pi-compatible tool result content
          const content = Array.isArray(res.content)
            ? res.content.map((item) => {
                if (item.type === "text") {
                  return { type: "text" as const, text: item.text };
                }
                return { type: "text" as const, text: JSON.stringify(item) };
              })
            : [{ type: "text" as const, text: JSON.stringify(res) }];

          return {
            content,
            isError: Boolean(res.isError)
          };
        } catch (err) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: err instanceof Error ? err.message : String(err)
                })
              }
            ],
            isError: true
          };
        }
      }
    };
  });
}

/**
 * Creates dynamic ToolRegistrations from all MCP servers configured in env.MCP_SERVERS.
 */
export async function createMcpTools(env?: {
  MCP_SERVERS?: string;
}): Promise<ToolRegistration[]> {
  if (!env?.MCP_SERVERS) return [];

  const serverConfigs = parseMcpServersConfig(env.MCP_SERVERS);
  const allTools: ToolRegistration[] = [];

  for (const [name, config] of serverConfigs) {
    try {
      const { tools } = await connectMcpServer(name, config);
      allTools.push(...tools);
    } catch (err) {
      console.warn(`Failed to connect to MCP server '${name}' at ${config.url}:`, err);
    }
  }

  return allTools;
}
