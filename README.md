# Policy Alignment Classifier

A guardrail for AI agents. An ops agent runs inside a Claude Code-style harness. Every trace
event it produces (`user_input`, `tool_call`, `tool_response`, `model_output`) is classified
against a written policy **before it takes effect**, and is then passed, flagged or blocked.

## Layout

```
policies/            the policies the guard enforces (see policies/README.md)
  ops-agent/
    policy.md        deployment and trust model: the policy text that isn't a rule
    rules.json       the rule table (number, name, prompt), editable from the Rules tab
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

You need [uv](https://docs.astral.sh/uv/), which installs a suitable Python (3.11+) for the
project, Node 18+, and an Anthropic API key. The backend and the UI run as two processes: the
API on http://localhost:8000 and the UI on http://localhost:5173, which forwards `/api` requests
to the API.

### Linux (and macOS, WSL)

Install the tools once:

```sh
curl -LsSf https://astral.sh/uv/install.sh | sh    # uv; open a new shell afterwards
# Node 18+: from your package manager, https://nodejs.org, or nvm (`nvm install --lts`)
```

Install and configure:

```sh
cd Policy-Alignment-Classifier
uv sync                            # creates .venv and installs the backend
cp .env.example .env               # then set ANTHROPIC_API_KEY in .env
(cd web && npm install)            # installs the UI
```

Run it in two terminals:

```sh
uv run policyguard                 # terminal 1: API on :8000 (works from any subfolder)
cd web && npm run dev              # terminal 2: UI on :5173
```

### Windows (PowerShell)

Install the tools once, then **open a new PowerShell window** so the new PATH takes effect:

```powershell
winget install --id astral-sh.uv
winget install --id OpenJS.NodeJS.LTS
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned   # lets npm.ps1 run; answer Y
```

Without `winget`, get uv with `powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"`
and Node from https://nodejs.org. If you'd rather not change the execution policy, use
`npm.cmd` wherever this README says `npm`.

Install and configure (keep the quotes if the path has spaces):

```powershell
cd "C:\path\to\Policy-Alignment-Classifier"
uv sync
Copy-Item .env.example .env        # then set ANTHROPIC_API_KEY in .env
cd web; npm install; cd ..
```

Run it in two PowerShell windows:

```powershell
uv run policyguard                 # window 1: API on :8000
cd web; npm run dev                # window 2: UI on :5173
```

Use `curl.exe`, not `curl`, for the examples below. In Windows PowerShell 5.1, `curl` is an
alias for `Invoke-WebRequest`.

### Sharing one checkout between Windows and WSL

`.venv` and `web/node_modules` are specific to the platform that created them. A Linux venv
has no `python.exe`, and Vite's esbuild and rollup ship native binaries. To run the same folder
from both:

- **Python:** give Windows its own venv. Set `UV_PROJECT_ENVIRONMENT=.venv-win` once, with
  `[Environment]::SetEnvironmentVariable("UV_PROJECT_ENVIRONMENT", ".venv-win", "User")`, and
  run `uv sync` again.
- **Node:** delete `web/node_modules` and run `npm install` again on whichever side you're
  switching to.
- **Ports:** stop the servers on one side before starting them on the other, because both
  sides use ports 8000 and 5173.

### Single-process demo

```sh
cd web && npm run build && cd ..   # Windows: cd web; npm run build; cd ..
uv run policyguard                 # UI and API together on http://localhost:8000
```

If `web/dist` exists, the backend serves it, so no Vite dev server is needed.

### Other commands

- `npm run dev:mock` (in `web/`) runs the UI on its own against an in-browser fake backend.
  Its verdicts are scripted and labelled "mock data".
- Tests: `uv run pytest` (makes no API calls).
- Red team: `uv run python scripts/redteam.py run` has Claude Opus 5.5 write hard test cases,
  scores this server's `/api/classify` on them, and adds rules that measurably help. It edits
  the live `rules.json`. See [docs/redteam.md](docs/redteam.md).
- Interactive API docs: http://localhost:8000/docs.
- Health check: `curl http://localhost:8000/api/health` (`curl.exe` on Windows).

### Troubleshooting

| Symptom | Fix |
|---|---|
| UI says "Backend is not reachable" | Start `uv run policyguard`, then reopen the tab. Tabs load again each time they're opened. |
| `uv` / `node` not found right after installing | Open a new terminal. VS Code has to be restarted before its terminals see the new PATH. |
| `npm.ps1 cannot be loaded because running scripts is disabled` | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, or use `npm.cmd`. |
| Vite fails with an esbuild or rollup platform error | `node_modules` was installed on another OS. Delete it and run `npm install` again. |
| Port 8000 or 5173 already in use | Another copy is running, possibly in WSL (`wsl pkill -f policyguard; wsl pkill -f vite`). You can also move the API with `PORT=8001` and point the UI at it with `CLASSIFIER_API=http://localhost:8001`. |
| Classifier errors / every event blocked | Check that `ANTHROPIC_API_KEY` in `.env` is set. In enforce mode the guard blocks anything it can't classify. |

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

## Limitations: conversation history

Each of the three places that call Claude handles history differently:

- **Agent: full history, never trimmed.** Every model call resends the session's whole
  conversation: each user turn, each assistant message as returned (thinking blocks included)
  and each tool result. Prompt caching makes repeated prefixes cheap, but nothing truncates or
  summarizes. A long session grows in cost and latency every turn and eventually hits the
  context window. When it does, the turn fails with an API error; nothing recovers from it.
- **Classifier: a short window of events, not the conversation.** Each classification is a
  single-turn request. Prior context is the last `context.max_events` events from the session
  (12 in both shipped policies), written into the prompt as text. The harness fetches up to 40
  events, and the prompt keeps the last 12. Anything older is invisible to the classifier. An
  attack spread across more than 12 events, such as a request set up early and acted on later,
  can pass even when each event looks harmless on its own. The window counts events, not
  tokens, so a few large tool results can make it expensive while many small events make it
  short-sighted.
- **Red-team script: no history.** Every call in `scripts/redteam.py` is a fresh single-turn
  request with one system prompt and one user message. Generation and grading see only what
  that prompt includes, not earlier calls in the run.
