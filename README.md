# @datagrout/n8n-nodes-datagrout

An [n8n](https://n8n.io) community node for interacting with a **DataGrout remote MCP server**.

DataGrout exposes each MCP server over HTTP at
`https://gateway.datagrout.ai/servers/{server-id}/mcp`. This node talks to the
stateless JSON-RPC endpoint (`/servers/{server-id}/rpc`) so you can list and call
the server's tools, resources, and prompts directly from an n8n workflow — or let
an n8n **AI Agent** use them as tools.

[Installation](#installation)
[Credentials](#credentials--datagrout-api)
[Operations](#operations)
[AI Agent](#use-with-the-ai-agent)
[Resources](#resources)

## Installation

Follow the [community node installation guide](https://docs.n8n.io/integrations/community-nodes/installation/)
and install `@datagrout/n8n-nodes-datagrout`.

## Credentials — DataGrout API

The node authenticates with a **Bearer access token**. Configure a *DataGrout API*
credential with:

| Field | Description |
|-------|-------------|
| **Gateway Base URL** | The gateway host. Defaults to `https://gateway.datagrout.ai`. |
| **Server ID** | The UUID of your target MCP server (the `{server-id}` in the gateway URL). |
| **Access Token** | A Bearer token created in the DataGrout UI under **Settings → Authentication → Create Access Token**. |

The credential's connection test issues a `tools/list` call against the server.

> **Note:** Only Bearer token authentication is supported in this version. mTLS
> and OAuth 2.1 (also supported by DataGrout) are planned for a future release.

## Operations

The node is organized by MCP concept:

- **Tool**
  - **List Tools** — list the tools the server exposes.
  - **Call Tool** — invoke a tool. Pick the tool from a searchable dropdown (or
    enter its name) and supply **Arguments** as a JSON object matching the tool's
    input schema.
- **Resource**
  - **List Resources** — list available resources.
  - **Read Resource** — read a resource by URI.
- **Prompt**
  - **List Prompts** — list available prompts.
  - **Get Prompt** — get a prompt by name, with optional JSON **Arguments**.
- **Advanced**
  - **Raw JSON-RPC** — send an arbitrary JSON-RPC `method` + `params` for any
    server capability not modeled above.

## Use with the AI Agent

This node is marked `usableAsTool`, so you can attach it to an n8n **AI Agent** as
a tool. The agent can call **List Tools** to discover what the server offers, then
**Call Tool** with the appropriate tool name and JSON arguments.

## Compatibility

Requires n8n@1.60.0 or later.

## Resources

- [DataGrout documentation](https://library.datagrout.ai/)
- [DataGrout authentication guide](https://library.datagrout.ai/authentication)
- [n8n community nodes documentation](https://docs.n8n.io/integrations/community-nodes/)

## License

[MIT](LICENSE)
