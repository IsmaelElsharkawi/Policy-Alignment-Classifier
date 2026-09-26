import { mockApi } from "./mock";
import type {
  Analytics,
  AnalyticsWindow,
  BenchReport,
  EvalReport,
  Mode,
  PerfReport,
  Policy,
  RuleEntry,
  RuleScopeMatrix,
  RulesConfig,
  ScenarioIn,
  ScenarioSummary,
  SessionDetail,
  SessionSummary,
  StreamMessage,
} from "./types";

export class ApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

const UNREACHABLE = "Backend is not reachable. Is it running on :8000?";

async function send(path: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      headers: { "Content-Type": "application/json" },
      ...init,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new ApiError(UNREACHABLE);
  }
  if (!res.ok) {
    if (res.status === 502 || res.status === 504) throw new ApiError(UNREACHABLE, res.status);
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail ?? body);
    } catch {
      // The Vite proxy answers a bodyless 500 when it cannot connect to the backend.
      if (res.status === 500) throw new ApiError(UNREACHABLE, res.status);
    }
    throw new ApiError(detail, res.status);
  }
  return res;
}

const json = <T>(path: string, init?: RequestInit) => send(path, init).then((r) => r.json() as Promise<T>);

/** Parses an NDJSON response body into messages as lines arrive. */
async function* ndjson(res: Response): AsyncGenerator<StreamMessage> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) yield JSON.parse(line) as StreamMessage;
    }
  }
  if (buffer.trim()) yield JSON.parse(buffer) as StreamMessage;
}

const httpApi = {
  createSession: (mode: Mode) =>
    json<SessionSummary>("/sessions", { method: "POST", body: JSON.stringify({ mode }) }),

  /** Sends a user message; yields each trace event (already classified) as the agent runs. */
  async *sendMessage(sessionId: string, content: string, mode: Mode, signal?: AbortSignal) {
    const res = await send(`/sessions/${sessionId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content, mode }),
      signal,
    });
    yield* ndjson(res);
  },

  listSessions: () => json<SessionSummary[]>("/sessions"),
  getSession: (id: string) => json<SessionDetail>(`/sessions/${id}`),
  analytics: (window: AnalyticsWindow) => json<Analytics>(`/analytics?window=${window}`),
  policy: () => json<Policy>("/policy"),
  latestEval: () => json<EvalReport>("/eval/latest"),
  perf: (window: AnalyticsWindow) => json<PerfReport>(`/perf?window=${window}`),
  bench: () => json<BenchReport>("/perf/bench"),
  rules: () => json<RulesConfig>("/rules"),
  saveRules: (scope: RuleScopeMatrix) =>
    json<RulesConfig>("/rules", { method: "PUT", body: JSON.stringify({ scope }) }),
  addRule: (entry: RuleEntry) =>
    json<RulesConfig>("/rules/entries", { method: "POST", body: JSON.stringify(entry) }),
  removeRule: (number: string) =>
    json<RulesConfig>(`/rules/entries/${encodeURIComponent(number)}`, { method: "DELETE" }),
  /** Writes a recorded scenario to bench/user_scenarios/<id>/ on the server. */
  saveScenario: (body: ScenarioIn) =>
    json<ScenarioSummary>("/scenarios", { method: "POST", body: JSON.stringify(body) }),
};

export type Api = typeof httpApi;

/** `npm run dev:mock` swaps in an in-browser fake backend so the UI can be reviewed alone. */
export const IS_MOCK = import.meta.env.VITE_MOCK === "1";
export const api: Api = IS_MOCK ? mockApi : httpApi;
