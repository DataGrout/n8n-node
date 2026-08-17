# @datagrout/n8n-nodes-datagrout

**DataGrout MCP** — an n8n node that calls a tool on your
[DataGrout](https://datagrout.ai) MCP server. Each node is pinned to one tool,
and because the node is marked `usableAsTool` it works in two places:

- **In a workflow** — Main in, Main out, like any other action node.
- **On an AI Agent's Tool connector** — the agent calls it and fills in the
  arguments itself.

This package has **no runtime dependencies**.

## What the node handles for you

- **Background tasks** — slow DataGrout requests are moved to a background task
  server-side; the node waits and returns the finished result.
- **Lean responses** — large result sets return as a short preview plus a
  server-side reference DataGrout's compute tools accept, keeping huge row sets
  out of the workflow or the agent's context.
- **Connection reuse** — calls share one server session instead of
  re-connecting every time.

## Installation

**Settings → Community Nodes → Install** → `@datagrout/n8n-nodes-datagrout`.

To use the node on an AI Agent's Tool connector on a self-hosted instance, set
`N8N_COMMUNITY_PACKAGES_ALLOW_TOOL_USAGE=true` and restart n8n.

## Credentials — DataGrout OAuth2 API

Create the credential and click **Connect my account**. That is the whole setup:
there is nothing to fill in.

No client ID or secret, because DataGrout registers OAuth clients dynamically
and n8n discovers the authorization server and registers itself. No server ID or
URL, because every account is served from one gateway endpoint. n8n also
refreshes the access token when it expires, so long-running workflows keep
working.

## Operations

| Operation | What it does |
|-----------|--------------|
| **Execute Tool** | Calls a tool on the server. |
| **List Tools** | Returns every allowed tool with its description and input schema. |

## Tools to Allow — the permission boundary

| Mode | Who picks the tool | Use it for |
|------|--------------------|-----------|
| **All** (default) | the model, at call time | giving an agent your whole server |
| **Selected** | the model, limited to your allow-list | giving an agent a safe subset |
| **Single Tool** | you, from a dropdown | a fixed step in a workflow |

With **Selected**, a tool outside the allow-list is refused rather than called,
even if the model asks for it.

## Usage in a workflow

1. Add a **DataGrout MCP** node and select the credential.
2. Set **Tools to Allow** to **Single Tool** and pick one in **Tool Name or ID** —
   the dropdown lists your server's tools.
3. Fill **Tool Arguments** with a JSON object matching that tool's input schema.

The node outputs the tool's `structuredContent` as item JSON when the server
provides it, so downstream nodes can map over real fields.

## Usage as an AI Agent tool

To give an agent access to your **whole server**, wire up two nodes:

1. A **DataGrout MCP** node set to **List Tools**, renamed something like
   *List DataGrout Tools*.
2. A second set to **Execute Tool** with **Tools to Allow** on **All**, renamed
   *Run DataGrout Tool*. Leave **Tool Name** and **Tool Arguments** alone — they
   already contain `$fromAI()`, so the model fills them at call time.
3. Connect both to the agent's **Tool** connector.

The agent calls List Tools to learn what exists, then calls Execute Tool with any
name it found. To narrow that down, switch **Tools to Allow** to **Selected** and
choose the tools it may reach.

Rename each node after what it does: n8n derives the agent-facing tool name from
the node's name on the canvas, so a clear name helps the model pick correctly.

When a call fails during agent execution, the node hands the error text back to
the model as data rather than aborting the agent's step, so the agent can read
the message and correct itself.

### Want every tool as a separate agent tool?

Use n8n's built-in **MCP Client Tool** node, which exposes each server tool to
the agent individually:

- **Server Transport**: HTTP Streamable
- **Endpoint**: `https://gateway.datagrout.ai/connect`
- **Authentication**: Bearer, with your DataGrout API token

A community node cannot reproduce that fan-out: n8n only splits one connection
into many agent tools when the value is an instance of `StructuredToolkit`, a
class inside `n8n-core` that community packages aren't allowed to import. The
trade-off is that the built-in node is generic — it won't do this package's
background-task collection or lean responses.

## Resources

- [DataGrout documentation](https://library.datagrout.ai/)
- [DataGrout authentication guide](https://library.datagrout.ai/authentication)
- [n8n community nodes documentation](https://docs.n8n.io/integrations/community-nodes/)

## License

[MIT](LICENSE)
