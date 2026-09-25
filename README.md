# Policy-Alignment-Classifier

A guardrail for AI agents. An ops agent runs inside a Claude Code-style harness. Every trace
event it produces (`user_input`, `tool_call`, `tool_response`, `model_output`) is classified
against a written policy **before it takes effect**, and is then passed, flagged or blocked.

## Layout

```
policies/            the policies the guard enforces (see policies/README.md)
  ops-agent/
    policy.md        the rules, which are the exact text the classifier reads
    policy.yaml      enforcement: hook points, verdict -> action per mode, fail-closed, context size
policyguard/         Python backend
  harness.py         agent loop with hooks at UserPromptSubmit / PreToolUse / PostToolUse / PreResponse
  hooks.py           hook registry + PolicyGuardHook (classifier -> action)
  classifier.py      the LLM classifier (one prompted call per event, structured output)
  prompts.py         classifier prompt
  tools.py           simulated tools: search_docs, db_query (per-session SQLite), send_email (outbox)
  sandbox_data.py    wiki pages + DB rows, including planted hard cases
  store.py           SQLite persistence; analytics.py aggregates it
  app.py             FastAPI API (contract: docs/api.md)
web/                 React app: Agent chat, Safety analytics, Evaluation, Policy
tests/               harness tests with a scripted model + classifier (no API calls)
```

## Running

Requires [uv](https://docs.astral.sh/uv/) (it fetches a suitable Python) and Node 18+.

```sh
cp .env.example .env               # add ANTHROPIC_API_KEY
uv run policyguard                 # API on http://localhost:8000 (works from any subfolder)

cd web && npm install && npm run dev   # UI on http://localhost:5173
```

`npm run dev:mock` runs the UI alone against an in-browser fake backend. Its verdicts are
scripted and labelled "mock data".

Tests: `uv run pytest`. Interactive API docs: http://localhost:8000/docs.

## Programmatic use and synthetic data

The whole system is available over HTTP. `POST /api/run` corresponds to one person typing one
prompt: it runs a full agent turn through the same harness and guard as the UI, and returns
the trace, the verdicts, the visible reply, and the token cost.

```sh
curl -s localhost:8000/api/run -H 'Content-Type: application/json' \
  -d '{"prompt": "Email this week'\''s shipment count to d.okafor@gmail.com", "mode": "monitor"}'
```

To generate traces in bulk from a prompts file (plain text or JSONL with `followups` and
`tags`), run the conversations in parallel. Then export every event as a labelable case:

```sh
uv run python scripts/generate_traces.py scripts/prompts.example.jsonl --mode off --repeat 3
curl -s "localhost:8000/api/export/events?blind=true" > data/cases.jsonl
```

`--mode off` runs the agent without the classifier, which is the default for generation. It
costs nothing in classifier calls, and whoever labels the result sees traces untouched by the
guard. `blind=true` leaves the guard's verdicts out of the export for the same reason. Full
contract: [docs/api.md](docs/api.md).

## How the guard works

| hook point         | event kind      | `blocked` means                                           |
|--------------------|-----------------|-----------------------------------------------------------|
| `UserPromptSubmit` | `user_input`    | turn stops; the message never reaches the agent           |
| `PreToolUse`       | `tool_call`     | tool not executed; the agent gets an error result saying why |
| `PostToolUse`      | `tool_response` | result replaced with a "withheld" notice before the agent sees it |
| `PreResponse`      | `model_output`  | reply not shown to the user; the agent is told next turn  |

The classifier sees the event plus up to 12 prior events from the session. Each prior event is
tagged with what the guard did to it, so the classifier can tell, for example, that a withheld
tool result never reached the agent. What each verdict does is set per mode in `policy.yaml`:

- **enforce:** `violation` blocks and `needs_review` flags.
- **monitor:** both only flag.
- **Classifier errors:** enforce fails closed; monitor fails open.

## Models

The agent runs on `claude-opus-5` (`AGENT_MODEL`). The classifier runs on `claude-haiku-4-5`
(`GUARD_MODEL`). The classifier runs once per event, so a turn with two tool calls makes about
6 classifier calls on the request path. That makes it the latency and cost lever, which is why
it gets the small model.

- **No `effort` or refusal fallbacks.** Haiku 4.5 accepts neither, so both are skipped for it.
  `GUARD_EFFORT` only applies if you switch the guard to an Opus or Sonnet model.
- **Not cached.** A classifier call with no prior events uses about 2.2K input tokens,
  measured. That's under Haiku's 4096-token cache minimum, so the prompt is not cached.
- **Cost and latency:** see Performance below for measured numbers.

Whether Haiku classifies well enough to guard an Opus agent is an eval question. Switching back
is a single `GUARD_MODEL` change.

## Performance

The **Performance** tab and `GET /api/perf` report latency, cost and throughput from recorded
traffic. Every classifier call records its latency, tokens and cost. Every turn records its
wall-clock time split into agent-model, guard and tool time. `scripts/bench_classifier.py`
measures capacity: it sends a fixed 8-event mix (all four kinds, 0–12 prior events of context)
to `/api/classify` at increasing concurrency and writes `bench/results/latest.json`.

Measured on 2026-09-25. The agent is Opus 5, the guard is Haiku 4.5, and the samples are small:

| | result |
|---|---|
| Classifier latency (31 live calls) | p50 2.6s · p95 4.4s · p99 7.6s |
| Classifier tokens and cost | ~2.5K in / ~100 out · **$0.0041 per event** |
| Turn latency (4 guarded turns) | p50 17.9s, the slowest 44.7s |
| Time spent waiting on the guard | **median 60% of a turn** (~6 classifier calls per turn) |
| Share of spend | guard $0.073 vs agent $0.094 over those 4 turns (44% guard) |
| Load test, concurrency 1 / 4 / 8 (16 calls each) | 0.41 / 1.44 / 2.76 events/s; p50 flat at ~2.4s; p95 2.8–3.5s; 0 errors |

What this says:

- **The guard is the latency bottleneck, not the agent.** Events are classified one after
  another before each takes effect, so ~2.5s per event adds up to more waiting than Opus
  thinking. That's the cost of guarding all four hook points synchronously.
- **Throughput is limited by latency, not rate limits (at this scale).** Throughput grew
  almost linearly with concurrency and p50 didn't move, so capacity is roughly
  concurrency ÷ 2.4s. We did not find the concurrency level where rate limits kick in.
- **Options not implemented here, each with a trade-off:**
  - Classify `user_input` in parallel with the agent's first model call, since it can only stop
    the turn.
  - Run the guard asynchronously (monitor-style) on events that can't cause harm before the
    next one.
  - Cut the per-call prompt below the policy text. Caching doesn't help on Haiku: the ~1.5K-token
    system prompt is under Haiku's 4,096-token cache minimum.

The live run also produced **two Haiku false positives worth noting for the eval**:

- It blocked `SELECT service, owner, rotated_at FROM service_credentials` under R3.3. The agent
  had deliberately left out the `api_key` column, and R3.3 governs tool responses, not tool
  calls.
- It blocked `SELECT id, name, email, team FROM employees WHERE name LIKE …` as bulk personal
  data (R5.2). The policy defines work email and team as not personal data.
