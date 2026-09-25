import { useEffect, useMemo, useState } from "react";
import { api, IS_MOCK } from "../api";
import type { EventKind, RuleEntry, RuleScopeMatrix, RulesConfig } from "../types";

const EMPTY_ENTRY: RuleEntry = { number: "", name: "", prompt: "" };

/**
 * Operator switchboard: for each policy rule and each trace position, is the rule enforced
 * ("Disallow": events that break it are violations) or switched off ("Allow": they pass)?
 * Saved to policies/<id>/rule_scope.json and applied to the next classified event.
 *
 * Above it, the rule table itself (policies/<id>/rules.json): each row's prompt is what the
 * classifier reads. Adding or removing a row takes effect on the next classified event.
 */
export function RulesView({ active }: { active: boolean }) {
  const [config, setConfig] = useState<RulesConfig | null>(null);
  const [draft, setDraft] = useState<RuleScopeMatrix>({});
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [newEntry, setNewEntry] = useState<RuleEntry>(EMPTY_ENTRY);
  const [tableBusy, setTableBusy] = useState(false);
  const [tableStatus, setTableStatus] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;
    api.rules().then(
      (c) => {
        setConfig(c);
        setDraft(structuredClone(c.scope));
        setError(null);
      },
      (e) => setError(e instanceof Error ? e.message : String(e)),
    );
  }, [active]);

  const dirty = useMemo(() => config !== null && JSON.stringify(draft) !== JSON.stringify(config.scope), [draft, config]);

  if (error && !config) return <div className="card error">{error}</div>;
  if (!config) return <p className="hint">Loading rules…</p>;

  const set = (rule: string, kind: EventKind, on: boolean) =>
    setDraft((d) => ({ ...d, [rule]: { ...d[rule], [kind]: on } }));
  const setColumn = (kind: EventKind, on: boolean) =>
    setDraft((d) => Object.fromEntries(Object.entries(d).map(([r, cells]) => [r, { ...cells, [kind]: on }])));
  const enforcedIn = (kind: EventKind) => config.rules.filter((r) => draft[r.id]?.[kind] !== false).length;

  const save = async () => {
    setSaving(true);
    setStatus(null);
    try {
      const c = await api.saveRules(draft);
      setConfig(c);
      setDraft(structuredClone(c.scope));
      setStatus("Saved. Applies to the next classified event, no restart needed.");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  // After a table edit the rule groups may change: keep unsaved switches for groups that still
  // exist, and take new groups from the server (enforced everywhere).
  const applyTableChange = async (change: () => Promise<RulesConfig>, done: string) => {
    setTableBusy(true);
    setTableStatus(null);
    try {
      const c = await change();
      setConfig(c);
      setDraft((d) => Object.fromEntries(Object.entries(c.scope).map(([id, cells]) => [id, d[id] ?? structuredClone(cells)])) as RuleScopeMatrix);
      setTableStatus(done);
      return true;
    } catch (e) {
      setTableStatus(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setTableBusy(false);
    }
  };

  const addRule = async () => {
    if (await applyTableChange(() => api.addRule(newEntry), `Added ${newEntry.number.trim()}. Applies to the next classified event.`))
      setNewEntry(EMPTY_ENTRY);
  };

  const removeRule = (number: string) => {
    if (!window.confirm(`Remove ${number} from the policy? The classifier stops seeing it on the next event.`)) return;
    void applyTableChange(() => api.removeRule(number), `Removed ${number}.`);
  };

  const canAdd = !tableBusy && newEntry.number.trim() !== "" && newEntry.name.trim() !== "" && newEntry.prompt.trim() !== "";

  const allOn = () =>
    setDraft(Object.fromEntries(config.rules.map((r) => [r.id, Object.fromEntries(config.positions.map((p) => [p.kind, true]))])) as RuleScopeMatrix);

  return (
    <div className="panel">
      <p className="hint">
        Policy <code>{config.policy_id}</code> v{config.policy_version}. <strong>Disallow</strong> enforces the rule
        at that position: events that break it are violations. <strong>Allow</strong> switches the rule off there:
        events that break only that rule pass. Switching off a rule also switches off its sub-rules.
        {IS_MOCK && " (Mock mode: saved in memory only; scripted verdicts don't react to it.)"}
      </p>

      <h3 className="section-title">Rule table</h3>
      <p className="hint">
        Each row is one rule the classifier is prompted with. Rows are grouped by their top-level number (R5, R5.1 and
        R5.2 form group R5), and a group is titled by the part of its name before the first <code>_</code>. Verdicts
        cite these numbers. Saved to <code>policies/{config.policy_id}/rules.json</code>.
        {IS_MOCK && " (Mock mode: kept in memory only.)"}
      </p>
      <div className="card table-scroll">
        <table className="grid rule-table">
          <thead>
            <tr>
              <th>Number</th>
              <th>Name</th>
              <th>Prompt</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {config.entries.map((e) => (
              <tr key={e.number}>
                <td className="rule-id">{e.number}</td>
                <td className="mono">{e.name}</td>
                <td className="rule-prompt">{e.prompt}</td>
                <td>
                  <button className="link danger" onClick={() => removeRule(e.number)} disabled={tableBusy}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td>
                <input
                  aria-label="New rule number"
                  placeholder="R8.1"
                  value={newEntry.number}
                  onChange={(ev) => setNewEntry({ ...newEntry, number: ev.target.value })}
                />
              </td>
              <td>
                <input
                  aria-label="New rule name"
                  placeholder="TOPIC_short_name"
                  value={newEntry.name}
                  onChange={(ev) => setNewEntry({ ...newEntry, name: ev.target.value })}
                />
              </td>
              <td>
                <textarea
                  aria-label="New rule prompt"
                  placeholder="What the classifier should allow or treat as a violation…"
                  rows={2}
                  value={newEntry.prompt}
                  onChange={(ev) => setNewEntry({ ...newEntry, prompt: ev.target.value })}
                />
              </td>
              <td>
                <button className="primary" onClick={addRule} disabled={!canAdd}>
                  {tableBusy ? "…" : "Add"}
                </button>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      {tableStatus && <p className="hint">{tableStatus}</p>}

      <h3 className="section-title">Where each rule applies</h3>
      <div className="card table-scroll">
        <table className="grid rules-matrix">
          <thead>
            <tr>
              <th>Rule</th>
              {config.positions.map((p) => (
                <th key={p.kind} className="pos-head">
                  <div className="pos-label">{p.label}</div>
                  <div className="hint">
                    <code>{p.kind}</code> · {p.hook}
                  </div>
                  <div className="hint">{p.description}</div>
                  <div className="col-actions">
                    <button className="link" onClick={() => setColumn(p.kind, true)}>
                      disallow all
                    </button>
                    <button className="link" onClick={() => setColumn(p.kind, false)}>
                      allow all
                    </button>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {config.rules.map((r) => (
              <tr key={r.id}>
                <th className="rule-cell">
                  <span className="rule-id">{r.id}</span> {r.title}
                  {r.subrules.length > 0 && <div className="hint mono">{r.subrules.join(" · ")}</div>}
                </th>
                {config.positions.map((p) => {
                  const on = draft[r.id]?.[p.kind] !== false;
                  const changed = on !== (config.scope[r.id]?.[p.kind] !== false);
                  return (
                    <td key={p.kind} className="toggle-cell">
                      <button
                        role="switch"
                        aria-checked={on}
                        aria-label={`${r.id} at ${p.label}: ${on ? "disallow (enforced)" : "allow (switched off)"}`}
                        className={`rule-toggle ${on ? "is-on" : "is-off"} ${changed ? "changed" : ""}`}
                        onClick={() => set(r.id, p.kind, !on)}
                      >
                        <span aria-hidden>{on ? "✕" : "✓"}</span> {on ? "Disallow" : "Allow"}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th className="hint">Enforced here</th>
              {config.positions.map((p) => {
                const n = enforcedIn(p.kind);
                return (
                  <td key={p.kind} className="hint">
                    {n} / {config.rules.length}
                    {n === 0 && <div className="skip-note">Classifier skipped at {p.hook}</div>}
                  </td>
                );
              })}
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="row">
        <button className="primary" onClick={save} disabled={!dirty || saving}>
          {saving ? "Saving…" : "Save"}
        </button>
        <button className="ghost" onClick={() => setDraft(structuredClone(config.scope))} disabled={!dirty}>
          Discard changes
        </button>
        <button className="ghost" onClick={allOn}>
          Reset to policy (disallow everywhere)
        </button>
        {dirty && <span className="hint">Unsaved changes</span>}
        {status && <span className="hint">{status}</span>}
      </div>

      <p className="hint">
        How a switched-off cell works: the classifier is told which rules are off for that position, and if it
        still returns a violation that cites only switched-off rules, the verdict becomes allow. The original
        verdict is kept on the event, so you can see what was let through and why. If every rule is off for a
        position, the classifier isn't called there at all, which saves its latency and cost.
      </p>
    </div>
  );
}
