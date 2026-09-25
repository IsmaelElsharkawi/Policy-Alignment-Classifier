import { useEffect, useState } from "react";
import { api } from "../api";
import type { Policy } from "../types";

/** The exact policy text the classifier is prompted with, served by the backend. */
export function PolicyPanel({ active }: { active: boolean }) {
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;
    api.policy().then(
      (p) => {
        setPolicy(p);
        setError(null);
      },
      (e) => setError(e instanceof Error ? e.message : String(e)),
    );
  }, [active]);

  if (error) return <div className="panel"><div className="card error">{error}</div></div>;
  if (!policy) return <div className="panel"><p className="hint">Loading policy…</p></div>;

  return (
    <div className="panel">
      <p className="hint">
        {policy.id} · version {policy.version}
      </p>
      <pre className="policy">{policy.text}</pre>
    </div>
  );
}
