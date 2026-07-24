# Examples

## `datagrout-ai-agent.json` — AI Agent with DataGrout (recommended starting point)

A chat-triggered AI Agent wired to a DataGrout server, with a system prompt that
is tuned for DataGrout's plan/execute workflow (the same prompt used in our
accuracy benchmarks). Questions like *"Which accounts closed deals in May but
have no open support tickets?"* run server-side and come back verified.

**Import**: n8n → Workflows → Import from File. Then:

1. Attach your OpenAI (or other chat model) credential to the model node.
2. Create a **DataGrout API** credential (token from your DataGrout dashboard,
   Server ID from `gateway.datagrout.ai/servers/{uuid}`) and select it on the
   **DataGrout MCP** node. (Self-hosted: install
   `@datagrout/n8n-nodes-datagrout-mcp` and set
   `N8N_COMMUNITY_PACKAGES_ALLOW_TOOL_USAGE=true`.)
3. Open the chat and ask a question about your connected data.
