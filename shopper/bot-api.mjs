// Settings and the calls to the bot's Worker, shared by main.mjs and try.mjs.
// Settings in shopper/.env: BOT_URL, SHOPPER_SECRET, VIEW_URL (where a person can see the browser), CDP_PORT.
import { readFileSync, existsSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { sleep } from './cdp.mjs';

const envFile = new URL('./.env', import.meta.url);
export const env = { ...process.env, ...(existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {}) };
for (const k of ['BOT_URL', 'SHOPPER_SECRET']) if (!env[k]) throw new Error(`Missing ${k} in shopper/.env`);

export const log = {
  info: (...a) => console.log(new Date().toISOString(), ...a),
  warn: (...a) => console.warn(new Date().toISOString(), 'WARN', ...a),
  error: (...a) => console.error(new Date().toISOString(), 'ERROR', ...a),
};

export async function bot(path, body = {}) {
  const res = await fetch(`${env.BOT_URL}/shopper/${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.SHOPPER_SECRET}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`bot ${path} ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return json;
}

export async function claude(body) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await bot('claude', body);
    } catch (err) {
      if (attempt >= 2 || !/ (429|5\d\d):/.test(err.message)) throw err;
      await sleep(5000 * (attempt + 1));
    }
  }
}

