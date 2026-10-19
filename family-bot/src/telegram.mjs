// Minimal Telegram Bot API client (built-in fetch only).
export class Telegram {
  constructor({ token, baseUrl = 'https://api.telegram.org', fetchImpl = (...a) => fetch(...a) }) {
    this.token = token;
    this.baseUrl = baseUrl;
    this.fetch = fetchImpl;
  }

  async call(method, body = {}, timeoutMs = 30_000) {
    const res = await this.fetch(`${this.baseUrl}/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = await res.json().catch(() => ({}));
    if (!json.ok) {
      const err = new Error(`Telegram ${method}: ${json.description ?? res.status}`);
      err.retryAfter = json.parameters?.retry_after;
      throw err;
    }
    return json.result;
  }

  getMe() { return this.call('getMe'); }

  getUpdates(offset, timeout = 50) {
    return this.call('getUpdates', {
      offset, timeout, allowed_updates: ['message', 'edited_message', 'my_chat_member', 'callback_query'],
    }, (timeout + 15) * 1000);
  }

  // Plain text (no parse_mode): text from users or the model cannot inject markup.
  // buttons: inline keyboard rows, attached to the last chunk.
  async send(chatId, text, { replyTo, buttons } = {}) {
    const chunks = [];
    for (let s = String(text); s.length; s = s.slice(4000)) chunks.push(s.slice(0, 4000));
    let last;
    for (const [i, chunk] of chunks.entries()) {
      last = await this.call('sendMessage', {
        chat_id: chatId, text: chunk, disable_web_page_preview: true,
        ...(replyTo && i === 0 ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
        ...(buttons && i === chunks.length - 1 ? { reply_markup: { inline_keyboard: buttons } } : {}),
      });
    }
    return last;
  }

  // New text without reply_markup, so the buttons go away.
  editText(chatId, messageId, text) {
    return this.call('editMessageText', { chat_id: chatId, message_id: messageId, text: String(text).slice(0, 4000), disable_web_page_preview: true }).catch(() => {});
  }

  answerCallback(id, text) { return this.call('answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) }).catch(() => {}); }

  typing(chatId) { return this.call('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {}); }

  leave(chatId) { return this.call('leaveChat', { chat_id: chatId }).catch(() => {}); }

  setCommands() {
    return this.call('setMyCommands', {
      commands: [
        { command: 'list', description: 'כל הרשימות' },
        { command: 'reminders', description: 'תזכורות פעילות' },
        { command: 'calendar', description: 'חיבור יומן גוגל' },
        { command: 'help', description: 'עזרה' },
        { command: 'id', description: 'מזהה הצ\'אט (להגדרה)' },
      ],
    }).catch(() => {});
  }
}
