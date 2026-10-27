# @datagrout/n8n-nodes-datagrout

Ask questions of your connected business data from n8n — and get answers you can
check.

[DataGrout](https://datagrout.ai) plans the work from your question, runs it
against the systems you have connected, verifies the result against what you
actually asked, and returns a certificate showing exactly what ran. When it
cannot verify a result it says so rather than answering anyway.

Two nodes:

| Node | Use it to |
|---|---|
| **DataGrout** | Ask questions, compute over data, store and recall facts, re-run verified work. Also works on an AI Agent's Tool connector. |
| **DataGrout Trigger** | Start a workflow when a DataGrout run or background task finishes or fails. |

The DataGrout node calls DataGrout's [REST API](https://library.datagrout.ai/rest-api).
No runtime dependencies.

## What you get that a plain HTTP call does not

- **A verified answer, or an admission.** Every answer says whether DataGrout's
  verifier accepted it, with a certificate showing the steps that produced it.
  An answer it could not verify arrives as `verified: false`, with `answer` empty
  and what the plan found under `unverified_answer` — never as a confident
  answer — so a workflow can branch on it instead of trusting it.
- **Memory that outlives the execution.** Facts stored in one run are still there
  in the next, and in other workflows pointed at the same memory.
- **Compute that stays next to the data.** A large result never has to travel
  through your workflow to be grouped or aggregated.
- **Events pushed to you.** The trigger registers its own webhook with DataGrout
  when you activate the workflow: no polling, nothing to paste into a dashboard.

## Operations

| Resource | Operation | What it does |
|---|---|---|
| **Answer** | Ask | Ask in plain language. DataGrout plans, runs and verifies, and returns the answer plus a certificate URL. |
| **Data** | Transform | Describe the result you want; DataGrout computes it on its own servers and returns records, one item per row. |
| **Memory** | Recall / Remember | Store facts as workflows run, then ask what is known — including what can be inferred from it. |
| **Skill** | Run | Re-run work DataGrout has already verified — a saved skill (`skill_…`), or the Skill ID an Ask returned. No planning, so it is fast and repeatable. |

### What Ask returns

| Field | |
|---|---|
| `answer` | The answer, or empty when it could not be verified |
| `verified` | Whether DataGrout's verifier accepted it |
| `unverified_answer`, `caveat` | What the plan found, and why it could not be verified |
| `certificate` | `id` and `url` of the certificate showing exactly what ran |
| `skill_id` | Run this verified work again with **Skill → Run**. An id beginning `skill_` does not expire; when `skill_expires` is true it lasts an hour. |
| `usage` | Credits charged and remaining |

### Why Transform is worth using

A large result never has to pass through your workflow. Ask an earlier step for a
**reference** instead of rows, hand that reference to Transform, and the grouping
or aggregation happens next to the data — you get back only the answer.

### Memory outlives the run

Facts stored with **Remember** are still there on the next execution, and in
other workflows pointed at the same memory. **Recall** answers from stored facts
and from what follows logically from them, with no model call.

## DataGrout Trigger

Activating the workflow registers a webhook with your DataGrout server, pointed
at the URL n8n gives the trigger. DataGrout then POSTs each event straight to
n8n, and deactivating the workflow removes the registration. You pick the
events you want:

| Event | Carries |
| --- | --- |
| Run Completed | `run_id`, `execution_id`, `status`, `tool_name`, `source`, `duration_ms` |
| Task Completed | `task_id`, `tool_name`, `cache_ref`, `status` |
| Task Failed | `task_id`, `tool_name`, `error`, `status` |
| Tool Call Failed | `run_id`, `execution_id`, `tool_name`, `error` |

`Run Completed` fires on every terminal status, so failed, timed-out and
cancelled runs arrive there too — the status comes with the event. Leave the
selection empty to receive everything, including events added to DataGrout after
this release.

`Task Failed` is the one nothing else reports: a background task's caller has
long stopped waiting by the time it fails.

`Task Completed` carries the result's `cache_ref`, so the next node can transform
that result server-side without re-fetching or recomputing it.

`run_id` is the integer DataGrout's own `runs.get` accepts, so a following node
can fetch the full run without translating anything.

Each registration comes with a secret that DataGrout presents on every delivery.
A request without it is answered 401 and never starts your workflow, and an
event you did not select is acknowledged and dropped.

DataGrout must be able to reach n8n over HTTPS at a public address. It refuses
plain HTTP and any `localhost` or private-network URL, so a self-hosted instance
needs a public `N8N_WEBHOOK_URL` (`WEBHOOK_URL` on older n8n).

Press **Listen for test event** in the editor, then make something happen in
DataGrout — a run finishing, a task failing — and the event lands in the editor
so you can wire downstream nodes against its real fields.

## Examples

Import any of these from **Workflows → Import from File**, then attach your
DataGrout credential to the DataGrout nodes.

| File | Shows |
|---|---|
| `examples/datagrout-ai-agent.json` | A chat AI Agent with DataGrout on its Tool connector. The recommended starting point. |
| `examples/datagrout-trigger-task-result.json` | A finished background task's `cache_ref` handed straight to Transform. |
| `examples/datagrout-trigger-failures.json` | One subscription, branching on `event` to route failures. |

## Installation

**Settings → Community Nodes → Install** → `@datagrout/n8n-nodes-datagrout`.

To use the node on an AI Agent's Tool connector on a self-hosted instance, set
`N8N_COMMUNITY_PACKAGES_ALLOW_TOOL_USAGE=true` and restart n8n.

## Credentials

Choose either on the node's **Authentication** field.

**DataGrout API** (simplest)

| Field | Where it comes from |
|---|---|
| API Token | Your DataGrout dashboard |
| Server ID | Your DataGrout server UUID |
| Gateway Base URL | Leave as-is unless you self-host the gateway |

**DataGrout OAuth2 API** — for instances that prefer an OAuth flow. Create the
credential, click **Connect my account**, and there is nothing to fill in: the
token itself names the server it was granted.

Testing a credential only reads — it fetches the server's name, changes nothing
and costs nothing.

## Using it with an AI Agent

The free-text fields default to `$fromAI(...)`, so an agent can fill them in with
no extra setup — connect the node to the agent's Tool connector and ask a
question. Replace a field with a fixed value to pin it.

## Options

- **Wait for Result** — DataGrout moves slow work to the background; the node
  waits this long for the finished result. Set 0 to return immediately with the
  task to follow.

On Transform, **Split Rows Into Items** (on by default) outputs one item per row
of the result. Turn it off to get the whole response as one item, with its
certificate and reference.

On the trigger:

- **Include Event Name** — add the event name to each item as `event`.

## Compatibility

Tested against n8n 2.29 and 2.45.

## Development

```bash
npm install
npm test          # unit tests, no dependencies
npm run build
npm run lint
```

## License

[MIT](LICENSE)
