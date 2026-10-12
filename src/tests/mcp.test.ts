import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { adaptMcpClient, createMcpTools, parseMcpServersConfig } from "../mcp";

describe("Component B & DoD 3: MCP Client Adapter & Dynamic Tool Registration", () => {
  describe("Config Parser", () => {
    it("parses JSON string config with object map", () => {
      const raw = JSON.stringify({
        github: { url: "https://mcp.github.com/sse", transport: "sse" },
        linear: "https://mcp.linear.app/mcp"
      });
      const parsed = parseMcpServersConfig(raw);
      expect(parsed.size).toBe(2);
      expect(parsed.get("github")).toEqual({
        url: "https://mcp.github.com/sse",
        transport: "sse",
        headers: undefined
      });
      expect(parsed.get("linear")).toEqual({
        url: "https://mcp.linear.app/mcp"
      });
    });

    it("parses array config format", () => {
      const raw = JSON.stringify([
        { name: "sentry", url: "https://mcp.sentry.io", headers: { Authorization: "Bearer key" } }
      ]);
      const parsed = parseMcpServersConfig(raw);
      expect(parsed.size).toBe(1);
      expect(parsed.get("sentry")?.url).toBe("https://mcp.sentry.io");
      expect(parsed.get("sentry")?.headers?.Authorization).toBe("Bearer key");
    });

    it("handles invalid or empty config gracefully", () => {
      expect(parseMcpServersConfig(undefined).size).toBe(0);
      expect(parseMcpServersConfig("").size).toBe(0);
      expect(parseMcpServersConfig("not-json").size).toBe(0);
    });
  });

  describe("MCP Tool Adapter & Execution Bridge", () => {
    it("connects to MCP server, namespaces tools, and invokes remote tool calls", async () => {
      // 1. Create linked in-memory transports
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

      // 2. Set up a mock remote MCP server
      const server = new Server(
        { name: "mock-github-mcp", version: "1.0.0" },
        { capabilities: { tools: {} } }
      );

      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
          {
            name: "get_issue",
            description: "Fetch issue information from GitHub MCP",
            inputSchema: {
              type: "object",
              properties: {
                issueNumber: { type: "number", description: "Issue number" }
              },
              required: ["issueNumber"]
            }
          },
          {
            name: "search_repositories",
            description: "Search repositories on GitHub MCP",
            inputSchema: {
              type: "object",
              properties: {
                query: { type: "string" }
              }
            }
          }
        ]
      }));

      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        if (request.params.name === "get_issue") {
          const num = request.params.arguments?.issueNumber;
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ id: num, title: "Test issue from MCP server", state: "open" })
              }
            ]
          };
        }
        if (request.params.name === "search_repositories") {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ results: ["vmlgtm/otto-pi", "vmlgtm/test-repo"] })
              }
            ]
          };
        }
        return {
          content: [{ type: "text", text: "Tool not found" }],
          isError: true
        };
      });

      await server.connect(serverTransport);

      // 3. Connect client over transport
      const client = new Client(
        { name: "test-client", version: "1.0.0" },
        { capabilities: {} }
      );
      await client.connect(clientTransport);

      // 4. Adapt client tools using adaptMcpClient with serverName 'github'
      const toolRegistrations = await adaptMcpClient("github", client);

      expect(toolRegistrations).toHaveLength(2);

      // Verify namespacing: github__get_issue and github__search_repositories
      const getIssueTool = toolRegistrations.find((t) => t.name === "github__get_issue");
      expect(getIssueTool).toBeDefined();
      expect(getIssueTool?.description).toBe("Fetch issue information from GitHub MCP");
      expect(getIssueTool?.replay).toBe("unsafe");

      const searchTool = toolRegistrations.find((t) => t.name === "github__search_repositories");
      expect(searchTool).toBeDefined();
      expect(searchTool?.description).toBe("Search repositories on GitHub MCP");

      // 5. Execute the adapted tool
      const execResult = await getIssueTool!.execute(
        { issueNumber: 42 },
        { callId: "c1" } as any,
        {} as any
      );

      expect(execResult.isError).toBe(false);
      const textOutput = execResult.content?.[0];
      expect(textOutput).toBeDefined();
      expect(textOutput?.type).toBe("text");
      const parsedData = JSON.parse((textOutput as any).text);
      expect(parsedData).toEqual({
        id: 42,
        title: "Test issue from MCP server",
        state: "open"
      });

      // Cleanup
      await client.close();
      await server.close();
    });

    it("returns empty list if env.MCP_SERVERS is not provided", async () => {
      const tools = await createMcpTools({});
      expect(tools).toEqual([]);
    });
  });
});
