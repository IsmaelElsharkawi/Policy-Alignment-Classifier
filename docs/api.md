# Backend API contract

The React app (`web/`) talks to the backend over the endpoints below. In dev, Vite proxies
`/api/*` to `http://localhost:8000` (override with `CLASSIFIER_API`). TypeScript types live in
[`web/src/types.ts`](../web/src/types.ts); `npm run dev:mock` serves the same contract from an
in-browser fake ([`web/src/mock.ts`](../web/src/mock.ts)) with scripted verdicts.

## Model

The backend runs a **coding agent** for Hugging Face engineers. It has six real tools.
`read_file`, `run_command` and `write_file` act on a workspace directory on the host
(`AGENT_WORKSPACE`, or a fresh `data/workspaces/<id>/` per session, cloned from `AGENT_REPO` if
set); `read_issue`, `hub_info` and `web_fetch` make live requests to GitHub, the Hub and the web. Every trace event — the user's message, each tool call,
each tool result, each reply — is classified against the policy **before it takes effect**, then
recorded with what the guardrail did:

| mode      | verdict `violation`                                  | `needs_review` | `allow` |
|-----------|------------------------------------------------------|----------------|---------|
| `enforce` | `blocked`                                            | `flagged`      | `passed`|
| `monitor` | `flagged`                                            | `flagged`      | `passed`|

What `blocked` means depends on position:

- `user_input` — the turn stops; the agent never sees the message.
- `tool_call` — the tool is not executed; the agent gets a "blocked by policy" result.
- `tool_response` — the result is withheld from the agent.
- `model_output` — the reply is replaced before it reaches the user.

A third mode, `off`, skips the guard entirely (see `POST /api/run`).

`needs_review` does not block in either mode (assumption: an agent that stalls on every
case the policy is silent about is unusable; review happens after the fact from the incident log).

## Types

```ts
TraceEvent     { kind, content?, tool_name?, arguments? }
ClassifyResult { verdict: "allow"|"violation"|"needs_review", rules: string[], category?: string,
                 rationale: string, evidence?: string,
                 meta: { model, latency_ms, input_tokens?, output_tokens?, cost_usd? } }
RecordedEvent  { id, session_id, seq, ts, event: TraceEvent,
                 classification: ClassifyResult | null, classifier_error?: string,
                 action: "passed"|"flagged"|"blocked" }
```

`category` names the attack/risk type for non-allow verdicts (`prompt_injection`,
`data_exfiltration`, `credential_disclosure`, …) and drives the analytics breakdown.

## Endpoints

### `POST /api/sessions` → `SessionSummary`
Body `{ "mode": "enforce" | "monitor" }`.

### `POST /api/sessions/{id}/messages` → NDJSON stream
Body `{ "content": "<user message>", "mode": "enforce" | "monitor" }`.
Response is `application/x-ndjson`, one JSON object per line, flushed as the agent runs:

```
{"type":"event","data":<RecordedEvent>}      one per trace event, in order
{"type":"error","detail":"..."}               optional, non-fatal
{"type":"done"}
```

### `POST /api/run` → `RunResponse`
The programmatic entry point. One call corresponds to one person typing one prompt. It runs a
full agent turn and returns it as one JSON document, not a stream.

```json
{ "prompt": "Here's my HF token hf_xxx, add it to the CI config",
  "mode": "monitor",            // enforce | monitor | off   (default enforce)
  "session_id": null }          // omit for a new session; pass one to continue a conversation
```

Response fields:

| field | meaning |
|---|---|
| `session_id` | pass it back to continue the conversation |
| `events` | every `RecordedEvent` of the turn, in order |
| `reply` | the `model_output` text the user would see (blocked outputs left out) |
| `turn_stopped` | the prompt itself was blocked |
| `n_blocked`, `n_flagged` | counts over `events` |
| `error` | set if the agent failed mid-turn; `events` still holds what happened |
| `latency_ms` | wall time for the turn |
| `usage` | agent calls, agent tokens, agent cost, classifier calls, classifier cost |
| `total_cost_usd` | agent cost plus classifier cost |

`mode: "off"` runs the agent with no classifier. Events are recorded with `action: "passed"`,
`classification: null`, and `mode: "off"`, and they are left out of analytics. Use it to
generate traces for a labelled eval set: there is no classifier cost, and the traces aren't
shaped by guard decisions. Each new session gets a fresh workspace (unless `AGENT_WORKSPACE` pins one), so runs
are independent.

Returns 409 if the session is already running a turn. Sessions are independent, so run them in
parallel.

### `GET /api/export/events` → JSONL
Every recorded event as a labelable case: the event, the prior events of its session as
`context` (at most the policy's `context.max_events`), and what the guard decided under `guard`.

Query parameters:
- `session_id=` filters to one session.
- `since=<ISO timestamp>` filters by time.
- `blind=true` removes `guard`, and removes `guard_action` from context events other than
  `blocked` ones. That way a human labeler isn't swayed by the classifier's opinion. A
  `blocked` action stays because it's a fact about what happened: the agent never saw that
  result, or the tool never ran.

```json
{"id": "ev_…", "session_id": "sess_…", "seq": 3, "ts": "…", "mode": "off",
 "event": {"kind": "tool_call", "tool_name": "run_command", "arguments": {…}},
 "context": [{"kind": "user_input", "content": "…"}, …],
 "label": null,
 "guard": {"action": "flagged", "verdict": "violation", "rules": ["R2"], …}}
```

### `POST /api/scenarios` → `ScenarioSummary`
Saves a scenario recorded in the Agent tab: the events of a session from `from_seq` on, plus
the events a person marked as guardrail failures. Each mark gives the verdict the event should
have had. The server works out the failure type:

- `miss`: the expected verdict is stricter than the guard's.
- `false_positive`: the expected verdict is more lenient.

An event with no verdict (guard off, or a classifier error) counts as `violation` if it was
blocked and `allow` otherwise.

```json
{"session_id": "sess_…", "from_seq": 0, "title": "…", "notes": "…",
 "marks": [{"event_id": "ev_…", "expected": "violation", "note": "…"}]}
```

Writes `bench/user_scenarios/<id>/` (`USER_SCENARIOS_DIR` moves it). The folder layout is in
[`bench/user_scenarios/README.md`](../bench/user_scenarios/README.md).

Error codes:

- **404:** unknown session.
- **409:** a turn is still running.
- **422:** a mark names an event outside the recording, or gives the verdict the guard already
  gave, or nothing was recorded.

### `GET /api/sessions` → `SessionSummary[]` (newest first)
### `GET /api/sessions/{id}` → `SessionDetail` (summary + `events: RecordedEvent[]`)

### `GET /api/analytics?window=24h|7d|all` → `Analytics`
Totals, verdict timeline (hourly buckets for `24h`, daily otherwise), non-allow counts by
category and by rule, verdict counts per event kind, classifier latency p50/p95, total
classifier cost, and the 50 most recent incidents.

### `POST /api/classify` → `ClassifyResult`
Body `{ "event": TraceEvent, "context": TraceEvent[] }`. Classifies one event statelessly;
used by the eval harness. `context` is the preceding events, oldest first; the verdict is only
about `event`.

### `GET /api/perf?window=24h|7d|all` → `PerfReport`
Latency, cost and throughput from recorded traffic. It covers classifier latency percentiles,
tokens and cost per event, and error rate; a latency timeline (p50/p95 per bucket); a
histogram; latency against input tokens; breakdowns by hook point and by classifier model;
per-turn wall time split into agent, guard and tool time (the median guard share, the 25 most
recent turns); and observed events per minute. Events in `off` mode are excluded.

### `GET /api/perf/bench` → `BenchReport`
The latest load test from `scripts/bench_classifier.py`. For each concurrency level it gives
throughput, client-side p50/p95/p99, the model's own p50, server overhead, tokens, cost,
errors, and p50 by context size. Returns 404 if no load test has been run.

### `GET /api/rules` → `RulesConfig`
The rules matrix behind the Rules tab. The response includes:
- the four positions: Tool call in = `tool_call`, Tool call out = `tool_response`,
  Model in = `user_input`, Model out = `model_output`;
- the policy's top-level rules, with their titles and sub-rules;
- `scope[rule][kind]`: `true` means the rule is enforced at that position, `false` means it is
  switched off there.

### `PUT /api/rules` → `RulesConfig`
Body `{ "scope": { "R2": { "tool_call": false, ... }, ... } }`. It replaces the whole matrix;
rules left out revert to enforced. The change applies to the next classified event, with no
restart, and is saved to `policies/<id>/rule_scope.json`. Unknown rules or positions return
422.

What a switched-off cell does:

1. The classifier is told which rules are off for that position.
2. If a non-allow verdict still cites only switched-off rules, it becomes `allow`. The
   original verdict is kept in `classification.overridden`.
3. If every rule is off for a position, the classifier isn't called at that hook. The event is
   recorded with no classification and shows as "Not checked".

Switching off a rule also switches off its sub-rules.

### `POST /api/rules/entries` → `RulesConfig`
Body `{ "number": "R8.1", "name": "VENDORS_contracts", "prompt": "..." }`. Adds a row to the
rule table in `policies/<id>/rules.json`. The classifier prompt is rebuilt for the next
classified event, with no restart. A new rule group starts enforced at every position. Returns
422 if the number is malformed (`R<n>` or `R<n>.<m>`) or already taken, or if the name or prompt
is empty.

### `DELETE /api/rules/entries/{number}` → `RulesConfig`
Removes a row. If that was the last row of its group, the group's scope row is dropped too.
Returns 404 for an unknown number, and 422 if it would leave the policy with no rules.

`RulesConfig.entries` lists the table's rows (`{ number, name, prompt }`) in number order.
`RulesConfig.rules` gives the groups derived from them.

### `GET /api/policy` → `{ id, version, text }`
The exact policy text the classifier is prompted with.

### `GET /api/eval/latest` → `EvalReport`
The most recent eval run written by the harness; 404 if none.

Errors: non-2xx with `{ "detail": "<message>" }`.
