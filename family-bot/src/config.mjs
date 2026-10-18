// Settings from environment variables (process.env on Node, the env object on Cloudflare Workers).
const list = (v) => String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const ids = (v) => new Set(list(v).map(Number).filter(Number.isFinite));

export function loadConfig(env) {
  const required = ['TELEGRAM_BOT_TOKEN', 'ANTHROPIC_API_KEY'];
  const missing = required.filter((k) => !env[k]);
  if (missing.length) throw new Error(`Missing settings: ${missing.join(', ')}`);
  const allowedChats = ids(env.ALLOWED_CHAT_IDS);
  const digestTime = env.DIGEST_TIME ?? '07:30';
  if (digestTime && !/^\d{2}:\d{2}$/.test(digestTime)) throw new Error('DIGEST_TIME must be HH:MM or empty');
  // Google Calendar through Google's MCP server (src/calendar.mjs): the OAuth client = on. The family connects with /calendar.
  const calendar = env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? {
    clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, calendarId: env.GOOGLE_CALENDAR_ID || 'primary',
    mcpUrl: env.GOOGLE_CALENDAR_MCP_URL || undefined, tokenUrl: env.GOOGLE_TOKEN_URL || undefined,
  } : null;
  return {
    telegramToken: env.TELEGRAM_BOT_TOKEN,
    telegramBaseUrl: env.TELEGRAM_API_BASE || 'https://api.telegram.org',
    webhookSecret: env.WEBHOOK_SECRET || null,
    shopperSecret: env.SHOPPER_SECRET || null, // the home machine that fills online carts (shopper/); empty = off
    shopperModel: env.SHOPPER_MODEL || 'claude-sonnet-5-5',
    botId: Number(String(env.TELEGRAM_BOT_TOKEN).split(':')[0]) || null, // the token starts with the bot id
    botUsername: env.BOT_USERNAME || null,
    anthropicKey: env.ANTHROPIC_API_KEY,
    anthropicBaseUrl: env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
    model: env.CLAUDE_MODEL || 'claude-sonnet-5-5',
    tz: env.HOUSE_TZ || 'Asia/Jerusalem',
    dbPath: env.DB_PATH || './data/house.db',
    allowedChats,
    allowedUsers: ids(env.ALLOWED_USER_IDS),
    mainChat: Number(env.MAIN_CHAT_ID) || [...allowedChats][0] || null,
    wakeWords: list(env.WAKE_WORDS ?? 'בוט,עוזר,bot'),
    members: list(env.FAMILY_MEMBERS),
    digestTime: digestTime || null,
    groupContext: Number(env.GROUP_CONTEXT ?? 15),
    maxDailyCalls: Number(env.MAX_DAILY_CALLS ?? 300),
    maxTokens: Number(env.MAX_TOKENS ?? 2048),
    webSearch: String(env.WEB_SEARCH ?? 'true').toLowerCase() === 'true',
    calendar,
    publicUrl: env.PUBLIC_URL || null, // the Worker's own address, for the Google sign-in callback (the Worker fills it in)
  };
}
