# @datagrout/n8n-nodes-datagrout

Ask questions of your connected business data from n8n — and get answers you can
check.

[DataGrout](https://datagrout.ai) plans the work from your question, runs it
against the systems you have connected, verifies the result against what you
asked, and returns a certificate showing exactly what ran. This node puts that
in a workflow, and on an AI Agent's Tool connector.

No runtime dependencies.

## Operations

| Resource | Operation | What it does |
|---|---|---|
| **Answer** | Ask | Ask in plain language. DataGrout plans, runs and verifies, and returns the answer plus a certificate URL. |
| **Data** | Transform | Describe the result you want; DataGrout computes it on its own servers and returns records. |
| **Memory** | Remember / Recall | Store facts as workflows run, then ask what is known — including what can be inferred from it. |
| **Skill** | Run | Re-run work DataGrout has already verified. No planning, so it is fast and repeatable. |

### Why Transform is worth using

A large result never has to pass through your workflow. Ask an earlier step for
a **reference** instead of rows, hand that reference to Transform, and the
grouping or aggregation happens next to the data — you get back only the answer.

### Memory outlives the run

Facts stored with **Remember** are still there on the next execution, and on
other workflows pointed at the same memory. **Recall** answers from stored facts
and from what follows logically from them, with no model call.

## Installation

**Settings → Community Nodes → Install** → `@datagrout/n8n-nodes-datagrout`.

To use it on an AI Agent's Tool connector on a self-hosted instance, set
`N8N_COMMUNITY_PACKAGES_ALLOW_TOOL_USAGE=true` and restart n8n.

## Credentials

Choose either on the node's **Authentication** field.

**DataGrout API** (simplest)

| Field | Where it comes from |
|---|---|
| API Token | Your DataGrout dashboard |
| Server ID | Your DataGrout server UUID |
| Gateway Base URL | Leave as-is unless you self-host the gateway |

**DataGrout OAuth2 API** — for instances that prefer an OAuth flow.

Testing the credential also switches on the JSON-RPC transport this node uses,
so there is nothing to configure in the DataGrout dashboard.

## Using it with an AI Agent

The free-text fields default to `$fromAI(...)`, so an agent can fill them in
with no extra setup — connect the node to the agent's Tool connector and ask a
question. Replace a field with a fixed value to pin it.

`examples/datagrout-ai-agent.json` is a ready-made chat agent wired to
DataGrout; import it from **Workflows → Import from File**.

## Options

- **Wait for Result** — DataGrout moves slow work to the background; the node
  waits this long for the finished result. Set 0 to return immediately.
- **Full Response** — return everything DataGrout sent rather than the tidied
  answer.

## Development

```bash
npm install
npm test          # unit tests, no dependencies
npm run build
npm run lint
```

## License

[MIT](LICENSE)
