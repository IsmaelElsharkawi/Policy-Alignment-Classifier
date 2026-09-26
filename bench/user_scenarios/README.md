# User scenarios

Each folder here is a stretch of an Agent-tab chat. Someone recorded it, and marked the events
where they saw the guardrail fail. To record one:

1. Click **● Record scenario** in the Agent tab. Recording starts with the next event; events
   already in the session become context.
2. Chat as usual. Each recorded step gets a **⚑ Mark failure** button. Pick the verdict the
   guard *should* have given, and optionally write what went wrong. A failure can be marked on
   any of the four positions:
   - user input
   - tool call
   - tool result
   - system output (the agent's reply)
3. Click **Stop & save**, give the scenario a title and notes, and save it. Saving calls
   `POST /api/scenarios` (see [docs/api.md](../../docs/api.md)), which writes the folder.

The failure type follows from the expected verdict and the guard's own. Strictness runs
`allow` < `needs_review` < `violation`.

| type | meaning |
|---|---|
| `miss` | the guard should have been stricter (for example, it allowed a violation) |
| `false_positive` | the guard should have been more lenient (for example, it blocked legitimate work) |

## Layout

```
<UTC timestamp>-<title slug>/
  scenario.json   title, notes, policy id and version, guard and agent models, session id,
                  from_seq, a summary, every marked failure (event, guard decision, expected
                  verdict, note), and every recorded event as the guard saw it
  cases.jsonl     one labelable case per recorded event, in the /api/export/events shape
```

In `cases.jsonl`, `label` is a verdict, and `label_source` says where it came from:

| `label_source` | `label` is |
|---|---|
| `user` | the verdict from the failure mark (`failure` and `note` are set too) |
| `unmarked` | the guard's own verdict: the person watched the event and did not mark it |
| `null` | unset: the guard never judged the event (guard off, or a classifier error) |

Each case's `context` includes events from before the recording started, up to the policy's
`context.max_events`.

## Replaying

`cases.jsonl` has the fields `scripts/redteam.py` expects, so a scenario doubles as a
regression suite for the current guard:

```sh
uv run python scripts/redteam.py replay bench/user_scenarios/<id>/cases.jsonl
```

This makes classifier calls only. It prints accuracy, attack success rate, false-block rate and
every case the guard now gets wrong. A marked failure that the guard now gets right means the
failure is fixed. An `unmarked` case that it now gets wrong is a regression.
