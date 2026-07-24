# @datagrout/n8n-nodes-datagrout-mcp

**DataGrout MCP** — an n8n AI Agent tool sub-node that exposes **every tool on
your DataGrout MCP server as a separate agent tool** (the same experience as the
built-in Atlassian/Linear MCP entries). No operation selector: just the
credential and a **Tools to Include** filter.

> **Self-hosted only.** This package ships runtime dependencies
> (`@langchain/core`, `zod`) and is intentionally **not** eligible for n8n
> verification. For a verified, zero-dependency node, see
> `@datagrout/n8n-nodes-datagrout`.

## What the node handles for you

- **Background tasks**: slow DataGrout requests are moved to a background task
  server-side; the node waits and returns the finished result — the agent just
  receives the answer.
- **Lean responses** (on by default): large result sets return as a short
  preview plus a server-side reference that DataGrout's compute tools accept,
  keeping huge row sets out of your workflow and agent context.
- **Connection reuse**: calls share one server session instead of
  re-connecting every time.

## Installation (self-hosted)

1. Install `@datagrout/n8n-nodes-datagrout-mcp` from **Settings → Community Nodes**.
2. Set `N8N_COMMUNITY_PACKAGES_ALLOW_TOOL_USAGE=true` and restart n8n.

Supported n8n versions: **2.29.x** (dependencies are pinned to match; other
versions may work but are untested).

## Credential — DataGrout API

Same credential as the main package (configure once, use in both):
**API Token** (from your DataGrout dashboard) + **Server ID** (UUID) +
**Gateway Base URL**.

## Usage

1. Add **DataGrout MCP** to an AI Agent's tool connector.
2. Pick the credential; choose **Tools to Include**:
   - **All** — every tool on the server
   - **Selected** — only the chosen tools
   - **All Except** — everything but the chosen tools
3. Chat — the agent sees each DataGrout tool separately (name, description,
   input schema) and calls them directly.

The filter is the **permission boundary**: filtered-out tools are never exposed
to or callable by the agent. With large servers (100+ tools), use **Selected**
to keep the model's context focused.

Click **Execute step** on the node to preview the tools it will expose.

## Resources

- [DataGrout documentation](https://library.datagrout.ai/)
- [n8n community nodes documentation](https://docs.n8n.io/integrations/community-nodes/)

## License

[MIT](LICENSE)
