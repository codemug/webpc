// BYOK cloud client (opt-in, per session). The API key lives in memory only: it is never
// persisted, exported or logged, and is cleared on reload, New chat, and switching back to a local model.
// Implements the same shape AgentSession expects (ready/stop/count/generate).
import { anthropicImageBlock, openAIImagePart, anthropicToolDefinitions, parseSSE, refusalNotice, estimateTokens } from './cloud.js';

const isToolResultMessage = (m, last) => last?.role === 'user' && Array.isArray(last.content) && last.content.every((b) => b.type === 'tool_result');
const toolResultHasError = (m) => { try { return Boolean(JSON.parse(m.content).error); } catch { return false; } };

// Scan one tee'd branch of an SSE body for choices[0].finish_reason (the last one wins); '' when
// absent. The body can reject (an aborted stream); the finish reason is then unknown, not an error.
async function readFinishReason(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let finish = '';
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        const data = line.trim().replace(/^data:/, '').trim();
        if (!data || data === '[DONE]') continue;
        let chunk; try { chunk = JSON.parse(data); } catch { continue; }
        const reason = chunk.choices?.[0]?.finish_reason;
        if (reason) finish = reason;
      }
    }
  } catch {
    // Aborted or failed body: stop scanning, the finish reason stays what it was.
  }
  return finish;
}

/** Local history → Anthropic Messages shape (system out to the `system` parameter; tool results merged into one user message). */
export function anthropicMapping(messages) {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  const out = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'user') {
      out.push(typeof m.content === 'string' ? { role: 'user', content: m.content }
        : { role: 'user', content: m.content.map((p) => p.type === 'image' ? anthropicImageBlock(p.image) : { type: 'text', text: p.text }) });
    } else if (m.role === 'assistant') {
      const blocks = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const record of m.tool_calls ?? []) blocks.push({ type: 'tool_use', id: record.id, name: record.function.name, input: record.function.arguments });
      out.push({ role: 'assistant', content: blocks.length ? blocks : ' ' });
    } else if (m.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content, is_error: toolResultHasError(m) };
      if (isToolResultMessage(m, out.at(-1))) out.at(-1).content.push(block);
      else out.push({ role: 'user', content: [block] });
    }
  }
  return { system, messages: out };
}

/** Local history → OpenAI-compatible chat-completions messages. */
export function openAIMapping(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'tool') out.push({ role: 'tool', tool_call_id: m.tool_call_id, content: m.content });
    else if (m.role === 'assistant' && m.tool_calls?.length) out.push({
      role: 'assistant', content: m.content || null,
      tool_calls: m.tool_calls.map((r) => ({ id: r.id, type: 'function', function: { name: r.function.name, arguments: JSON.stringify(r.function.arguments) } })),
    });
    else if (typeof m.content === 'string') out.push({ role: m.role, content: m.content });
    else out.push({ role: m.role, content: m.content.map((p) => p.type === 'image' ? openAIImagePart(p.image) : { type: 'text', text: p.text }) });
  }
  return { messages: out };
}

export class CloudClient {
  /** `loadSdk` is injectable so the Anthropic streaming path is unit-testable (default: the vendored bundle). */
  constructor({ fetch: fetcher = globalThis.fetch, loadSdk = null } = {}) {
    this.fetch = fetcher; this.loadSdk = loadSdk ?? (() => import('./vendor/anthropic-sdk.mjs'));
    this.ready = false; this.provider = null; this.model = null; this.baseUrl = null; this.key = null; this.effort = 'medium';
    this.active = new Map(); // request id -> AbortController: several requests may run at once
    this.nextId = 0;
  }
  /** Validate and activate a provider. @returns {{ host: string }} the host prompts are sent to (for the opt-in notice). */
  configure({ provider, model, baseUrl = null, key, effort = 'medium' }) {
    if (!String(key ?? '').trim()) throw new Error('Enter your API key.');
    if (!String(model ?? '').trim()) throw new Error('Enter the model name.');
    if (provider === 'anthropic') {
      this.provider = 'anthropic'; this.baseUrl = 'https://api.anthropic.com';
    } else {
      let url; try { url = new URL(String(baseUrl ?? '')); } catch { throw new Error('Enter a full base URL, e.g. https://api.openai.com/v1'); }
      if (url.protocol !== 'https:') throw new Error('The base URL must use https.');
      this.provider = 'openai'; this.baseUrl = url.origin + url.pathname.replace(/\/+$/, ''); // keep the path (api.openai.com/v1) without a trailing /
    }
    this.model = String(model).trim();
    this.effort = ['low', 'medium', 'high'].includes(effort) ? effort : 'medium';
    this.key = String(key);
    this.ready = true;
    return { host: new URL(this.baseUrl).hostname };
  }
  get host() { return this.ready ? new URL(this.baseUrl).hostname : ''; }
  /** Abort every in-flight request only; the key and opt-in survive a Stop. */
  stop() { for (const controller of this.active.values()) controller.abort(); this.active.clear(); }
  /** New chat, switching to a local model, or closing the app: forget everything. */
  clear() { this.stop(); this.ready = false; this.provider = null; this.model = null; this.baseUrl = null; this.key = null; }
  count(messages) { return Promise.resolve(estimateTokens(messages)); }
  /** The facade path: the request id plus its promise; each request gets its own AbortController. */
  generateRequest(messages, schemas, onToken = () => {}) {
    const id = ++this.nextId;
    const controller = new AbortController();
    const promise = new Promise((resolve, reject) => {
      if (!this.ready) return reject(new Error('Enable a cloud model in Settings first.'));
      this.active.set(id, controller);
      const run = this.provider === 'anthropic' ? this.generateAnthropic(messages, schemas, onToken, controller) : this.generateOpenAI(messages, schemas, onToken, controller);
      const done = run.then((value) => { this.active.delete(id); return value; }, (error) => { this.active.delete(id); throw error; });
      done.then(resolve, reject);
    });
    return { id, promise };
  }
  /** Abort one request only (a thread's Stop). */
  abort(id) { this.active.get(id)?.abort(); }
  async generate(messages, schemas, onToken = () => {}) { return this.generateRequest(messages, schemas, onToken).promise; }
  async generateAnthropic(messages, schemas, onToken, controller) {
    const sdk = await this.loadSdk();
    const { Anthropic, APIError, APIConnectionError, APIUserAbortError, AuthenticationError, RateLimitError } = sdk;
    const client = new Anthropic({ apiKey: this.key, dangerouslyAllowBrowser: true });
    const { system, messages: apiMessages } = anthropicMapping(messages);
    const params = {
      model: this.model,
      max_tokens: 64000,
      system,
      messages: apiMessages,
      // Opus 5.5 request rules: no thinking, no sampling parameters, no assistant prefill, tool_choice auto.
      tool_choice: { type: 'auto' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: this.effort },
    };
    if (schemas.length) params.tools = anthropicToolDefinitions(schemas);
    try {
      const stream = client.beta.messages.stream(params, { signal: controller.signal });
      // The SDK's `text` event passes (textDelta: string, textSnapshot: string) — the delta itself is the text.
      stream.on('text', (delta) => onToken(delta));
      const final = await stream.finalMessage();
      const toolCalls = (final.content ?? []).filter((b) => b.type === 'tool_use').map((b) => ({ name: b.name, arguments: b.input ?? {} }));
      const text = (final.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
      if (final.stop_reason === 'refusal') return { text, toolCalls: [], refusal: refusalNotice(final.stop_details) };
      return { text, toolCalls, ...(final.stop_reason === 'max_tokens' && { truncated: true }) };
    } catch (err) {
      if (err?.name === 'AbortError' || err instanceof APIUserAbortError) throw new DOMException('Stopped', 'AbortError');
      if (err instanceof AuthenticationError) throw new Error('The Anthropic API key was rejected. Check it in Settings and try again.');
      if (err instanceof RateLimitError) throw new Error('Anthropic rate limit hit. Wait a moment and send again.');
      if (err instanceof APIConnectionError) throw new Error('Could not reach api.anthropic.com. Check your connection and try again.');
      if (err instanceof APIError) throw new Error(`Anthropic error ${err.status}: ${err.message}`);
      throw err;
    }
  }
  async generateOpenAI(messages, schemas, onToken, controller) {
    const { messages: apiMessages } = openAIMapping(messages);
    const body = { model: this.model, messages: apiMessages, stream: true };
    if (schemas.length) { body.tools = schemas; body.tool_choice = 'auto'; } // toolSchemas() is already the function format
    try {
      const response = await this.fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST', signal: controller.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.key}` },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        let detail = ''; try { detail = (await response.json()).error?.message ?? ''; } catch {}
        const http = new Error(`The endpoint returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
        http.httpStatus = response.status;
        throw http;
      }
      // The controller stays in the active map until the request settles, so stop() can still abort
      // while parseSSE reads the body.
      let accumulated = '';
      // parseSSE (cloud.js, another lane's file) does not report finish_reason; tee the body and
      // scan the second branch so a length stop gets the same truncated flag as the local worker.
      const [main, probe] = response.body.tee();
      const finish = readFinishReason(probe);
      const { text, toolCalls } = await parseSSE(main, (piece) => (accumulated += piece, onToken(piece)));
      return { text, toolCalls, ...((await finish) === 'length' && { truncated: true }) };
    } catch (err) {
      if (err?.name === 'AbortError') throw new DOMException('Stopped', 'AbortError');
      if (err?.httpStatus) throw err;
      throw new Error('Could not reach the OpenAI-compatible endpoint. Check the base URL and your connection.');
    }
  }
}
