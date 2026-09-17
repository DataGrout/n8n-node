# Examples

## `datagrout-ai-agent.json` — AI Agent with DataGrout (recommended starting point)

A chat-triggered AI Agent wired to a DataGrout server, with a system prompt that
is tuned for DataGrout's plan/execute workflow (the same prompt used in our
accuracy benchmarks). Questions like *"Which accounts closed deals in May but
have no open support tickets?"* run server-side and come back verified.

**Import**: n8n → Workflows → Import from File. Then:

1. Attach your OpenAI (or other chat model) credential to the model node.
2. Create a **DataGrout OAuth2 API** credential, click **Connect my account**,
   and select it on the **DataGrout** node. There is nothing to fill in.
   (Self-hosted: set `N8N_COMMUNITY_PACKAGES_ALLOW_TOOL_USAGE=true` to use the
   node on an AI Agent's Tool connector.)
3. Open the chat and ask a question about your connected data.

## `datagrout-trigger-task-result.json` — pick up a finished background task

A long DataGrout call detaches to a background task and returns immediately. The
trigger hears `task.completed`, and the event carries the result's `cache_ref` —
so the next node transforms that result server-side without re-fetching or
re-computing anything. This is why `cache_ref` is on the wire.

**Import**, then attach a DataGrout credential to both nodes and activate the
workflow. Use **Test step** on the trigger to emit a shaped example if you want
to wire the downstream node before a real task finishes.

## `datagrout-trigger-failures.json` — route failures

DataGrout publishes every server event to one topic, so a workflow subscribes
once and branches on `event`. This one listens for `task.failed` and
`tool_call.failed` and splits them.

`task.failed` is the one nothing else reports: whoever started the task stopped
waiting long before it failed. Replace the two No-Op nodes with whatever you
want to happen — a Slack message, an incident ticket, a DataGrout **Memory →
Remember** step that records the failure as a fact you can query later.
