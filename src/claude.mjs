// Claude Messages API with a tool loop. Built-in fetch only.
import { TOOLS, WEB_SEARCH_TOOL, runTool } from './tools.mjs';
import { SYSTEM_PROMPT } from './prompt.mjs';

const MAX_STEPS = 8;

export class Claude {
  constructor({ apiKey, model, baseUrl = 'https://api.anthropic.com', fetchImpl = (...a) => fetch(...a), maxTokens = 2048, webSearch = false }) {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl;
    this.fetch = fetchImpl;
    this.maxTokens = maxTokens;
    // Cache the long, stable prefix (tools + system prompt): the cache mark goes on the last tool.
    const all = webSearch ? [...TOOLS, WEB_SEARCH_TOOL] : TOOLS;
    this.tools = all.map((t, i) => (i === all.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t));
  }

  async call(body) {
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await this.fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(90_000),
      });
      if (res.ok) return res.json();
      const text = await res.text().catch(() => '');
      lastErr = new Error(`Claude API ${res.status}: ${text.slice(0, 300)}`);
      if (![429, 500, 502, 503, 529].includes(res.status)) break;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
    throw lastErr;
  }

  /**
   * history: [{role, content: string}] earlier turns in this chat.
   * userText: the new message (already prefixed with the sender name).
   * ctx: tool context (db, tz, chatId, user, lastLocation) + contextText.
   * Returns { text, usage, toolCalls }.
   */
  async respond({ history, userText, ctx, contextText }) {
    const messages = [...history.map((h) => ({ role: h.role, content: h.content })), { role: 'user', content: userText }];
    // The API needs the first message to be from the user.
    while (messages.length && messages[0].role !== 'user') messages.shift();
    const usage = { input: 0, output: 0 };
    const toolCalls = [];
    for (let step = 0; step < MAX_STEPS; step++) {
      const resp = await this.call({
        model: this.model,
        max_tokens: this.maxTokens,
        system: [
          { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: contextText },
        ],
        tools: this.tools,
        messages,
      });
      usage.input += (resp.usage?.input_tokens ?? 0) + (resp.usage?.cache_creation_input_tokens ?? 0) + (resp.usage?.cache_read_input_tokens ?? 0);
      usage.output += resp.usage?.output_tokens ?? 0;
      usage.searches = (usage.searches ?? 0) + (resp.usage?.server_tool_use?.web_search_requests ?? 0);
      messages.push({ role: 'assistant', content: resp.content });
      // A long web search can pause; send the same messages again to continue.
      if (resp.stop_reason === 'pause_turn') continue;
      const uses = resp.content.filter((b) => b.type === 'tool_use');
      if (resp.stop_reason !== 'tool_use' || uses.length === 0) {
        const textBlocks = resp.content.filter((b) => b.type === 'text');
        let text = textBlocks.map((b) => b.text).join('').trim();
        // Web search answers must show their sources.
        const urls = [...new Set(textBlocks.flatMap((b) => (b.citations ?? []).map((c) => c.url).filter(Boolean)))].slice(0, 3);
        if (urls.length) text += `\n\nמקורות:\n${urls.join('\n')}`;
        return { text, usage, toolCalls };
      }
      const results = [];
      for (const u of uses) {
        try {
          const out = await runTool(u.name, u.input ?? {}, ctx);
          toolCalls.push({ name: u.name, ok: true });
          results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out) });
        } catch (err) {
          toolCalls.push({ name: u.name, ok: false, error: err.message });
          results.push({ type: 'tool_result', tool_use_id: u.id, content: `שגיאה: ${err.message}`, is_error: true });
        }
      }
      messages.push({ role: 'user', content: results });
    }
    return { text: 'מצטער, לא הצלחתי לסיים את הבקשה. נסו לנסח אותה אחרת.', usage, toolCalls };
  }
}
