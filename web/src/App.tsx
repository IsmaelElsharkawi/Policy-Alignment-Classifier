import { useState } from "react";
import { IS_MOCK } from "./api";
import { AgentView } from "./components/AgentView";
import { AnalyticsView } from "./components/AnalyticsView";
import { EvalPanel } from "./components/EvalPanel";
import { PerformanceView } from "./components/PerformanceView";
import { PolicyPanel } from "./components/PolicyPanel";
import { RulesView } from "./components/RulesView";

type TabId = "agent" | "analytics" | "performance" | "rules" | "eval" | "policy";

const TABS: { id: TabId; label: string }[] = [
  { id: "agent", label: "Agent" },
  { id: "analytics", label: "Safety analytics" },
  { id: "performance", label: "Performance" },
  { id: "rules", label: "Rules" },
  { id: "eval", label: "Evaluation" },
  { id: "policy", label: "Policy" },
];

export default function App() {
  const [tab, setTab] = useState<TabId>("agent");
  // Bumped after each agent turn so analytics refetch on next view.
  const [activity, setActivity] = useState(0);

  return (
    <div className={`app ${tab === "agent" ? "app-agent" : ""}`}>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">◆</span> Policy Guard
          <span className="brand-sub">ops-agent guardrail</span>
        </div>
        <nav className="tabs">
          {TABS.map((t) => (
            <button key={t.id} className={tab === t.id ? "active" : ""} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
        {IS_MOCK && (
          <span className="mock-banner" title="Verdicts are scripted by src/mock.ts, not produced by the classifier.">
            mock data
          </span>
        )}
      </header>

      {/* Panels stay mounted so switching tabs keeps the conversation and filters. */}
      <main className="content" hidden={tab !== "agent"}>
        <AgentView onActivity={() => setActivity((n) => n + 1)} />
      </main>
      <main className="content page" hidden={tab !== "analytics"}>
        <AnalyticsView active={tab === "analytics"} refreshKey={activity} />
      </main>
      <main className="content page" hidden={tab !== "performance"}>
        <PerformanceView active={tab === "performance"} refreshKey={activity} />
      </main>
      <main className="content page" hidden={tab !== "rules"}>
        <RulesView active={tab === "rules"} />
      </main>
      <main className="content page" hidden={tab !== "eval"}>
        <EvalPanel active={tab === "eval"} />
      </main>
      <main className="content page" hidden={tab !== "policy"}>
        <PolicyPanel active={tab === "policy"} />
      </main>
    </div>
  );
}
