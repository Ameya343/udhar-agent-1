// The shop's language model, as a chain of OpenAI-compatible chat endpoints. Each call tries the providers in order
// and moves on when one fails, times out or answers with JSON we cannot use; when all fail the caller falls back to
// the offline rules. Nothing here is provider-specific: plain /chat/completions, temperature 0, no JSON mode
// unless LLM_JSON_MODE=1, so any vLLM / Ollama / Groq / Sarvam / router endpoint works.
//
//   LLM_BASE_URL      optional first provider, e.g. a vLLM server with an open-source model: https://host/v1
//   LLM_API_KEY       optional bearer key for LLM_BASE_URL
//   LLM_MODEL         model id for LLM_BASE_URL; without LLM_BASE_URL it is the router's model (unset = router default)
//   LLM_BASE_TIMEOUT_MS  default 6000: how long the first provider gets before the router answers instead
//   AGENT37_LLM_PROXY_URL / AGENT37_MANAGED_TOKEN  the Agent37 router (set by Agent37; the token is read per call)
//   ROUTER_MODEL      optional router model id when LLM_BASE_URL is set (unset = router default)
//   LLM_TIMEOUT_MS    default 8000: the router's timeout
//   LLM_JSON_MODE     1 = also send response_format {type: json_object} (only for endpoints that support it)

/** The first complete JSON object in a model's reply: code fences, prose around it and trailing commas are tolerated. */
type Env = Record<string, string | undefined>;
export type ChatMessage = { role: string; content: string };
/** Options for one chatJson call. validate gets the model's parsed JSON (any shape) and returns the cleaned value or throws. */
export interface ChatOpts<T = unknown> { timeoutMs?: number; maxTokens?: number; model?: string; json?: boolean; validate?: (j: any) => T }
export interface ChatResult<T = unknown> { value: T; provider: string; model: string; ms: number }
interface ProviderStats { calls: number; ok: number; failed: number; lastError: string | null; lastMs: number | null }
interface Provider { name: string; url: string; model: string | null; key: () => string; timeoutMs: number; stats?: ProviderStats }
type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; signal: AbortSignal; body: string }) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;
export interface LlmOpts { env?: Env; fetch?: FetchLike }
export type Llm = ReturnType<typeof createLlm>;

/** The model's JSON reply is untyped (`any`); callers validate it. */
function extractJson(content: unknown): any {
  const s = String(content == null ? '' : content).replace(/```(?:json)?/gi, '');
  for (let start = s.indexOf('{'); start >= 0; start = s.indexOf('{', start + 1)) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        const raw = s.slice(start, i + 1);
        try { return JSON.parse(raw); } catch (e) {
          try { return JSON.parse(raw.replace(/,\s*([}\]])/g, '$1')); } catch (e2) { break; }
        }
      }
    }
  }
  throw new Error('reply had no JSON');
}

function createLlm(opts: LlmOpts) {
  const env = opts.env || {};
  const fetchImpl = opts.fetch || globalThis.fetch;
  const now = () => Date.now();
  const trim = (u: string | undefined) => String(u || '').replace(/\/+$/, '');
  const providers: Provider[] = [];
  if (env.LLM_BASE_URL) {
    providers.push({ name: 'custom', url: trim(env.LLM_BASE_URL), model: env.LLM_MODEL || null, key: () => env.LLM_API_KEY || '', timeoutMs: +env.LLM_BASE_TIMEOUT_MS! || 6000 });
  }
  if (env.AGENT37_LLM_PROXY_URL) {
    providers.push({ name: 'router', url: trim(env.AGENT37_LLM_PROXY_URL), model: (env.LLM_BASE_URL ? env.ROUTER_MODEL : env.LLM_MODEL) || null, key: () => env.AGENT37_MANAGED_TOKEN || '', timeoutMs: +env.LLM_TIMEOUT_MS! || 8000 });
  }
  for (const p of providers) p.stats = { calls: 0, ok: 0, failed: 0, lastError: null, lastMs: null };
  const stats: { calls: number; fallbacks: number; lastProvider: string | null; lastError: string | null } = { calls: 0, fallbacks: 0, lastProvider: null, lastError: null };

  async function callOne<T>(p: Provider, messages: ChatMessage[], o: ChatOpts<T>): Promise<ChatResult<T>> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), o.timeoutMs || p.timeoutMs);
    const t0 = now();
    p.stats!.calls++;
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      const k = p.key();
      if (k) headers.authorization = 'Bearer ' + k;
      const body: { temperature: number; max_tokens: number; messages: ChatMessage[]; model?: string | null; response_format?: { type: string } } = { temperature: 0, max_tokens: o.maxTokens || 400, messages };
      if (o.model || p.model) body.model = o.model || p.model;
      if (env.LLM_JSON_MODE === '1' && o.json !== false) body.response_format = { type: 'json_object' };
      const res = await fetchImpl(p.url + '/chat/completions', { method: 'POST', headers, signal: ctrl.signal, body: JSON.stringify(body) });
      if (!res.ok) throw new Error('LLM HTTP ' + res.status);
      const j = await res.json();
      const content = (((j.choices || [])[0] || {}).message || {}).content || '';
      const value = o.validate ? o.validate(extractJson(content)) : extractJson(content);
      p.stats!.ok++; p.stats!.lastError = null; p.stats!.lastMs = now() - t0;
      return { value, provider: p.name, model: j.model || p.model || 'default', ms: now() - t0 };
    } catch (e: any) { // anything thrown: fetch, JSON or the validator
      p.stats!.failed++; p.stats!.lastMs = now() - t0;
      p.stats!.lastError = e.name === 'AbortError' ? 'LLM timeout' : String(e.message || e).slice(0, 200);
      throw Object.assign(new Error(p.stats!.lastError), { provider: p.name });
    } finally { clearTimeout(timer); }
  }

  /**
   * One JSON answer from the first provider that gives a valid one. o.validate(json) returns the cleaned value or
   * throws (then the next provider is asked). Throws when every provider failed; the caller uses its rules then.
   */
  async function chatJson<T = any>(messages: ChatMessage[], o?: ChatOpts<T>): Promise<ChatResult<T>> {
    o = o || {};
    const list = providers;
    if (!list.length) throw new Error('no LLM configured');
    stats.calls++;
    let last: Error | null = null;
    for (const p of list) {
      try {
        const r = await callOne(p, messages, o);
        stats.lastProvider = p.name; stats.lastError = null;
        return r;
      } catch (e) { last = e as Error; }
    }
    stats.fallbacks++; stats.lastProvider = 'rules'; stats.lastError = last ? last.message : 'failed';
    throw last || new Error('LLM failed');
  }

  return {
    enabled: providers.length > 0,
    providers,
    chatJson,
    stats,
    describe: () => providers.map((p) => p.name + ':' + (p.model || 'default')).join(' -> ') || 'none',
    health: () => ({
      chain: providers.map((p) => p.name).concat('rules'), lastProvider: stats.lastProvider, lastError: stats.lastError, calls: stats.calls, fallbacks: stats.fallbacks,
      providers: Object.fromEntries(providers.map((p) => [p.name, { model: p.model || 'default', calls: p.stats!.calls, ok: p.stats!.ok, failed: p.stats!.failed, lastMs: p.stats!.lastMs, lastError: p.stats!.lastError }]))
    })
  };
}

export { createLlm, extractJson };
