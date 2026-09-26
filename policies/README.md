# Policies

This directory holds the policies the guard enforces. The server loads one at startup, chosen
by `POLICY=<id>` (default `coding-agent`).

```
policies/<id>/
  policy.md    the context for the rules, in prose: deployment, tools, trust model, general
               notes. Everything here goes into the classifier prompt as written.
  rules.json   the rule table, a list of { number, name, prompt }. Edited from the Rules tab
               (add / remove) or by hand. It is rendered into a "## Rules" section appended to
               policy.md, so policy.md + rules.json is the exact text the classifier reads.
  policy.yaml  enforcement: which hook points run the classifier, what each verdict does
               per mode (enforce / monitor), fail-open vs fail-closed on classifier errors,
               how much trace context the classifier sees, and the allowed risk categories.
  rule_scope.json  (optional) which rules are enforced at which trace position. Edited from
               the Rules tab. If it's missing, every rule is enforced everywhere, i.e. the policy
               as written.
```

The split is on purpose. `policy.md` and `rules.json` say **what is allowed** and are written
for a reader, human or model. `policy.yaml` says **what happens** when something is not allowed. That is an
operational choice, and it can change without touching the policy's meaning. For example, you can
run a new policy in `monitor` mode before enforcing it.

## The rule table

```json
{ "number": "R5.1", "name": "PERSONAL DATA_person",
  "prompt": "Personal data of the specific person a task is about may be looked up and shown to the user." }
```

- `number` is `R<n>` or `R<n>.<m>`. Rows with the same `R<n>` form a group. The group is what
  the Rules tab switches on and off per position, and the number is what verdicts cite. A bare
  `R<n>` row is a good place for the group's definitions or exceptions.
- `name` is for people. The part before the first `_` becomes the group's title in the prompt
  (`### R5 — PERSONAL DATA`), so give every row in a group the same prefix.
- `prompt` is the rule text the classifier reads, as one `- **R5.1** ...` line.

Rows are kept sorted by number. If you change what a rule means, bump `version` in
`policy.yaml`, so that eval results and records can be tied to the rules that produced them.
`policy.md` refers to some rules by number (the trust model names R6 and R7.1), so keep it in
step when you renumber or remove those.

To add a policy, copy `coding-agent/`, edit the files, and start the server with `POLICY=<new id>`.
The eval harness reads the same files, so eval results are always tied to a policy version.
