# Agent scheduling tools

The `schedule_chat` capability is available by default. With Schedules enabled, select the
Schedules tool group for an agent to enable `create_schedule`, `list_schedules`, `get_schedule`,
`update_schedule`, and `delete_schedule`. Tools are not added to agents automatically. An explicit
endpoint capabilities list can exclude scheduling. The tools use the existing native approval
flow and Schedules list.

## Scope and input

Every operation is scoped to the authenticated user, executing saved agent and current chat
project. Outside a project, only schedules originating from this chat are in scope. Callers
cannot provide user, agent, project or conversation IDs. Only the schedule ID to manage is
model-supplied; knowing another ID cannot expand access.

`create_schedule` accepts `name`, optional `description`, `prompt: { text, file_ids? }`,
`cadence` and `mode`. New conversations inherit the current project; conflicting operator
project policy rejects creation instead of silently placing it outside the tool's scope.
`continue` and `steer` bind to this chat. The server records its originating conversation.
`prompt.text` is an instruction for this agent to execute later, not the notification body.
For example: “Tell the user it is time to go for their run.”

`create_schedule` returns only `{ "id": "sched_…" }`.
`list_schedules` takes no arguments and returns `{ schedules: [...] }`. Get and update return
the model-facing record: editable fields, run status and timestamps, excluding ownership IDs,
revision numbers and scheduler bookkeeping. The default timezone is omitted from results; a
saved timezone that differs from the browser default appears inside `cadence`.
`get_schedule` and `delete_schedule` take `id`. `update_schedule` takes `id` and the
fields to change directly, for example `{ "id": "sched_…", "name": "Go running" }`.
The server remembers the last accessed revision in the current chat; updates require a prior
create, get or list there, and refuse concurrent edits until the record is read again.
Omitted fields remain unchanged;
prompt and cadence are replaced as whole objects when supplied. `enabled` pauses/resumes.
Explicitly supplied modes bind to this chat; omitted modes preserve the saved destination.

Tool cadence times use the user’s browser timezone automatically. An optional `cadence.timezone`
IANA override supports scheduling in another timezone.
One-shot `at` values use local `YYYY-MM-DDTHH:mm` wall-clock time. Recurring times use the same
browser timezone. The tool receives the current local date/time for relative requests such as
“today at 19:25”. Existing schedules retain their saved timezone unless their cadence is replaced. Registered attachment IDs can
refer to uploads or published generated files owned by the user. Local paths must first pass
through the normal file publication flow.

## Approval and execution

Reads need SCHEDULES USE. Writes need USE and CREATE, matching the existing UI permission
contract. Writes ask for native approval by default; explicit `toolApproval.allow` rules can
permit them without a prompt, while explicit ask/deny rules keep their normal precedence.
For example, this permits creation while leaving other schedule writes asking by default:

```yaml
endpoints:
  agents:
    toolApproval:
      enabled: true
      allow: ['create_schedule']
```

The permission and scheduled-run recursion checks apply even when a tool is explicitly allowed.
Scheduled generations may read their scope but cannot create, update or delete schedules.

The shared UI handlers own validation, limits and persistence. Creation retry identity binds
the user, tenant, conversation, generation, saved agent and original tool call. Reusing it
cannot create duplicates. Scope checks still apply to a committed replay after context changes.
The revision cache shares the configured checkpoint/approval retention window. An update attempt
keeps its original observed revision across retries, including approval resumes. Revision conflicts
on update require a fresh read and a new tool call. Deletion reports actual draining/cancellation
state rather than claiming a live generation stopped before persistence acknowledges it.

`fire` starts a new chat; `continue` waits for the original chat's running or paused generation
before appending a turn; `steer` queues instructions for its active generation or records an
inactive skip. Continuation uses the latest-created assistant response, matching existing
trigger semantics rather than a browser-selected historical branch. Steering completion means
durable queue acceptance, not proof that a model acted on the instruction.

One-shots have no cadence jitter and disable after dispatch. Their occurrence evidence survives
for their own generation and approval resumes. Completed one-shots count toward the schedule
limit until deleted. Normal scheduler polling can delay actual dispatch after the scheduled
instant. Old schedules without origin metadata remain manageable through the normal UI; an
unprojected chat cannot discover them through these tools without proof of its origin.

# Unattended MCP support

Scheduled chats validate the selected agent and its accessible graph agents before creation,
when enabling or changing the agent, and before each automatic or manual dispatch.
The check uses the persisted user document and plugin credentials, with temporary
user connections that are disposed afterwards. It does not borrow a browser session
or replace a live interactive connection. Graph agents are loaded in breadth-first
batches, and private children are skipped with the same VIEW rule as a live run.
Enabled spawn-agent members are included when the endpoint grants that capability.
The effective endpoint must grant the tools capability. Tool discovery uses the configured
per-admission concurrency (one to ten, default three), must complete, and must contain all
explicitly selected tools; wildcard selections require a nonempty catalog. Request disconnects
and scheduler shutdown cancel connection setup and discovery without advancing the occurrence.
Readiness admissions use a separate bounded pool and complete before a durable generation
slot is reserved, so slow MCP servers cannot consume generation capacity or block later
healthy occurrences from being considered.

Supported authentication is determined by a successful unattended connection:

- Static server credentials and anonymous servers.
- Persisted custom user variables, including API keys.
- Stored MCP OAuth credentials that can connect or refresh without user interaction.

Browser-only credentials, interactive OpenID bearer/OBO sources, missing user
variables, and OAuth grants needing renewed consent cannot be assumed available.
An OBO server without a host-owned renewable upstream-token provider reports
`mcp_configuration_missing` with `detail: 'unattended_auth_required'` (a
backward-compatible subtype); reconnecting in a browser cannot make it ready.
The operator must configure a properly authorized unattended provider, or the
owner must remove the server from the agent. Other servers with missing user
credentials can be reconnected or configured in an interactive agent chat.
A browser connection alone does not prove readiness; enabling always reruns
the unattended check.

`mcp_reauth_required`, `mcp_configuration_missing`, and `mcp_permission_denied`
stop a scheduled occurrence and disable the schedule immediately. The permission status tells the owner that an administrator must
restore MCP use access. `mcp_unavailable` counts
toward the existing configured consecutive-failure threshold. Credential-store and
configuration-store outages are transient; they must never be treated as proof of missing credentials.
Failure records contain only server names and resolution statuses, never exception
messages or OAuth URLs. Successful dispatch records also retain the server outcomes.

The schedule card shows failed servers and links to the selected agent for recovery.
A pure pause remains available even when MCP validation fails. This change does not
re-enable existing schedules automatically or repair credentials on the user's behalf.

## Host token-provider context

`createMCPPreflight` and `createInitializeClient` accept a
`HostUpstreamTokenProviderResolver`. The default application does not install one.
The host receives the persisted/authenticated user and these optional fields:

```ts
resolveUpstreamTokenProvider(user, {
  signal,
  context: { scheduleId, ownerId, tenantId, agentId, invocationMode: 'delegated' },
  target: { mcpServer, scopes },
});
```

Admission allocates a proposed schedule ID before preflight and persists that same ID
only if creation succeeds. Preflight is validation, not a provisioning/consent hook:
hosts must not create durable grants keyed by this proposed ID. Failed admission or a
concurrent idempotency-key winner can discard it. Edits
and dispatch use the existing schedule ID. Execution derives the context from the
verified schedule trigger and authenticated owner, then captures it before tool loading.
`agentId` identifies the root scheduled agent throughout child execution and handoffs.
After an approval pause, the resume host restores the context from the saved job after
validating ownership, tenancy, agent identity, and schedule liveness. An explicit initializer
argument carries this restored context; resume body fields cannot replace it.
The existing resolver closure is passed through tool discovery, execution, and reconnects;
it never goes into tool arguments or durable job payloads.

Each OBO consumer supplies its server name and configured scopes after its existing trust
check. A run shares in-flight lookups and successful providers only for identical server
and scope pairs. Failed or empty lookups may retry; cancellation belongs to the owning run,
so cancelling one child does not cancel a sibling's lookup.

`tenantId` is absent in deployments without tenancy. `context` is absent for legacy callers
that supply no schedule ID or verified trigger, and `target` is absent for legacy consumers.
Existing callbacks may ignore the new fields. Hosts needing either field must reject its
absence. Context describes execution; it is not a consent grant or permission to mint.
Current schedules execute with their owner's authority, hence `delegated`. Dedicated agent
authorization requires a separate implementation. Scopes are not an STS audience; audience
mapping and authorization remain the host's responsibility.

This interface adds no token store, STS exchange, consent API, or new MCP credential mode.
