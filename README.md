# @datagrout/n8n-nodes-datagrout

Connect n8n — and its **AI Agents** — to your **DataGrout MCP servers**. List a
server's tools and execute them, right inside your workflows.

## Zero-config alternative

You can already use DataGrout with **no custom node**: add n8n's built-in
**MCP Client Tool**, set the Endpoint to your gateway URL
(`https://gateway.datagrout.ai/servers/<uuid>/mcp`), and use Bearer/OAuth2 auth
with All / Selected / All Except. This package adds DataGrout branding, a
purpose-built credential (token + server ID), and discoverability in the nodes
panel.

## What the node handles for you

- **Background tasks**: slow DataGrout requests are moved to a background task
  server-side; the node waits and returns the finished result (configurable via
  the **Wait for Background Tasks** option — set 0 to receive the task
  reference instead).
- **Lean responses** (on by default): large result sets return as a short
  preview plus a server-side reference that DataGrout's compute tools accept,
  keeping huge row sets out of your workflow and agent context.
- **Connection reuse**: calls share one server session instead of
  re-connecting every time.

## Installation

- **n8n Cloud / self-hosted:** install `@datagrout/n8n-nodes-datagrout` from the
  Community Nodes panel.
- **Self-hosted, as an agent tool:** set
  `N8N_COMMUNITY_PACKAGES_ALLOW_TOOL_USAGE=true` and restart. (On Cloud, verified
  nodes work as agent tools with no env var.)

## Credentials — DataGrout API

Create a **DataGrout API** credential:

| Field | Description |
|-------|-------------|
| **API Token** | Generate it in your DataGrout dashboard. |
| **Server ID** | Your server's UUID (from `gateway.datagrout.ai/servers/{uuid}`). |
| **Gateway Base URL** | Defaults to `https://gateway.datagrout.ai`. |

The credential test runs a minimal MCP `initialize` round-trip against your server.

## Operations

- **List Tools** — returns each tool's name, description, and input schema
  (respects the tool filter below).
- **Execute Tool** — runs a named tool with JSON **Tool Arguments** and returns
  its result.

## Tool filter — All / Selected / All Except

- **All** — every tool on the server.
- **Selected** — only the tools you pick.
- **All Except** — every tool except the ones you pick.

When the node is attached to an AI Agent, this is the **permission boundary** for
what the agent is allowed to call.

## Use as an AI Agent tool

Attach the **DataGrout** node to the AI Agent's tool connector. The agent reads
the node description + tool list and supplies the tool name and arguments itself
(via `$fromAI`). Typical flow: the agent calls **List Tools** to discover names,
then **Execute Tool**.

**Example:** Chat Trigger → AI Agent (with a chat model) → attach **DataGrout** as
a tool → *"List the tools on my DataGrout server, then run &lt;tool&gt;."*

## Resources

- [DataGrout documentation](https://library.datagrout.ai/)
- [DataGrout authentication guide](https://library.datagrout.ai/authentication)
- [n8n community nodes documentation](https://docs.n8n.io/integrations/community-nodes/)
- Repository: https://github.com/DataGrout/n8n-node

## License

[MIT](LICENSE)
