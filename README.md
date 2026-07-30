# @datagrout/n8n-nodes-datagrout

**DataGrout MCP** — an n8n AI Agent tool node that connects your agents to a
[DataGrout](https://datagrout.ai) MCP server. It lists the server's tools when
attached and exposes **every tool as a separate agent tool** (name, description,
and input schema each) — the agent picks and calls them directly. No operation
selector: just the credential and a tool filter.

## What the node handles for you

- **Background tasks** — slow DataGrout requests are moved to a background task
  server-side; the node waits and returns the finished result.
- **Lean responses** — large result sets return as a short preview plus a
  server-side reference DataGrout's compute tools accept, keeping huge row sets
  out of the agent's context.
- **Connection reuse** — calls share one server session instead of
  re-connecting every time.

## Installation (self-hosted)

1. **Settings → Community Nodes → Install** → `@datagrout/n8n-nodes-datagrout`.
2. Set `N8N_COMMUNITY_PACKAGES_ALLOW_TOOL_USAGE=true` and restart n8n.

> This package ships runtime dependencies (`@langchain/core`, `zod`) and
> targets self-hosted instances. Supported n8n versions: **2.29.x**
> (dependencies are pinned to match).

## Credentials — DataGrout API

| Field | Description |
|-------|-------------|
| **API Token** | Generate it in your DataGrout dashboard. |
| **Server ID** | Your server's UUID (from `gateway.datagrout.ai/servers/{uuid}`). |
| **Gateway Base URL** | Defaults to `https://gateway.datagrout.ai`. |

The credential test runs a real MCP `initialize` round-trip.

## Usage

1. Add an **AI Agent** (with a chat model) to a workflow.
2. Attach **DataGrout MCP** to the agent's **Tool** connector and select the
   credential.
3. Choose **Tools to Include**:
   - **All** — every tool on the server
   - **Selected** — only the chosen tools
   - **All Except** — everything except the chosen tools
4. Chat — the agent sees each DataGrout tool separately and calls them as
   needed.

The filter is the **permission boundary**: filtered-out tools are never exposed
to or callable by the agent. With large servers (100+ tools), prefer
**Selected** to keep the model's context focused.

Click **Execute step** on the node to preview the tools it will expose.

## Resources

- [DataGrout documentation](https://library.datagrout.ai/)
- [DataGrout authentication guide](https://library.datagrout.ai/authentication)
- [n8n community nodes documentation](https://docs.n8n.io/integrations/community-nodes/)

## License

[MIT](LICENSE)
