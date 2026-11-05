// Block 24c: alerts to a Discord channel through an incoming webhook. Only
// discord.com / discordapp.com webhook URLs are accepted, no redirects are
// followed and every request has a fixed timeout. The URL works like a
// password (anyone holding it can post), so it is only ever shown masked.
export const DISCORD_HOSTS = Object.freeze(['discord.com', 'discordapp.com']);
export const DISCORD_TIMEOUT_MS = 5_000;
export const DISCORD_MAX_RETRY_AFTER_MS = 10_000;
const PATH = /^\/api(?:\/v\d{1,2})?\/webhooks\/(\d{15,22})\/([A-Za-z0-9_-]{20,200})$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };

export function validateDiscordWebhookUrl(input) {
  const text = typeof input === 'string' ? input.trim() : '';
  let url;
  try { url = new URL(text); } catch { fail('DISCORD_URL_INVALID'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) fail('DISCORD_URL_INVALID');
  if (!DISCORD_HOSTS.includes(url.hostname.toLowerCase())) fail('DISCORD_HOST_NOT_ALLOWED');
  if (!PATH.test(url.pathname)) fail('DISCORD_URL_INVALID');
  return `https://${url.hostname.toLowerCase()}${url.pathname}`;
}

// https://discord.com/api/webhooks/1234…/abcd… → id shortened, token hidden.
export function maskDiscordWebhookUrl(url) {
  if (!url) return null;
  const match = PATH.exec(new URL(url).pathname);
  return match ? `https://${new URL(url).hostname}/api/webhooks/${match[1].slice(0, 4)}…/••••${match[2].slice(-4)}` : 'https://discord.com/api/webhooks/…';
}

const COLORS = { bad: 0xd45c5c, good: 0x6bc47b, warn: 0xd4a65c, info: 0x5c9ad4 };
// Server names come from config files and must not ping anyone: mentions are
// switched off and the text is plain.
export function discordMessage(alert) {
  return {
    username: 'COD4X CONTROL',
    allowed_mentions: { parse: [] },
    embeds: [{ title: String(alert.title).slice(0, 256), description: String(alert.body || '').slice(0, 2000), color: COLORS[alert.severity] ?? COLORS.info, timestamp: new Date(alert.t ?? Date.now()).toISOString() }],
  };
}

export async function sendDiscord(url, alert, { fetchImpl = fetch, timeoutMs = DISCORD_TIMEOUT_MS, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const target = validateDiscordWebhookUrl(url);
  const body = JSON.stringify(discordMessage(alert));
  for (let attempt = 0; attempt < 2; attempt++) {
    let response;
    try { response = await fetchImpl(target, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { 'Content-Type': 'application/json' }, body }); }
    catch (error) { return { ok: false, status: null, code: error.name === 'TimeoutError' ? 'DISCORD_TIMEOUT' : 'DISCORD_NETWORK' }; }
    const text = await response.text().catch(() => '');
    if (response.ok) return { ok: true, status: response.status };
    if (response.status !== 429) return { ok: false, status: response.status, code: `DISCORD_HTTP_${response.status}` };
    // Rate limited: honour Retry-After once if it is short, otherwise give up.
    let retryAfterMs = Number(response.headers.get('retry-after')) * 1000;
    try { const parsed = JSON.parse(text); if (Number.isFinite(parsed?.retry_after)) retryAfterMs = parsed.retry_after * 1000; } catch { /* header only */ }
    if (attempt > 0 || !Number.isFinite(retryAfterMs) || retryAfterMs > DISCORD_MAX_RETRY_AFTER_MS) return { ok: false, status: 429, code: 'DISCORD_RATE_LIMITED', retryAfterMs: Number.isFinite(retryAfterMs) ? retryAfterMs : null };
    await wait(Math.max(0, retryAfterMs));
  }
  return { ok: false, status: 429, code: 'DISCORD_RATE_LIMITED' };
}
