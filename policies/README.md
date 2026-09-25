# Policies

This directory holds the policies the guard enforces. The server loads one at startup, chosen
by `POLICY=<id>` (default `ops-agent`).

```
policies/<id>/
  policy.md    the rules, in prose. This is the exact text the classifier is prompted with.
               Rule headings must start with an id (### R1 — ...) so verdicts can cite them.
  policy.yaml  enforcement: which hook points run the classifier, what each verdict does
               per mode (enforce / monitor), fail-open vs fail-closed on classifier errors,
               how much trace context the classifier sees, and the allowed risk categories.
  rule_scope.json  (optional) which rules are enforced at which trace position. Edited from
               the Rules tab. If it's missing, every rule is enforced everywhere, i.e. the policy
               as written.
```

The split is on purpose. `policy.md` says **what is allowed** and is written for a reader, human
or model. `policy.yaml` says **what happens** when something is not allowed. That is an
operational choice, and it can change without touching the policy's meaning. For example, you can
run a new policy in `monitor` mode before enforcing it.

To add a policy, copy `ops-agent/`, edit both files, and start the server with `POLICY=<new id>`.
The eval harness reads the same files, so eval results are always tied to a policy version.
