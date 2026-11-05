import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { ALERT_DEFAULTS, MonitorAlerts, formatDuration, validateAlertRules } from '../lib/monitor-alerts.mjs';
import { discordMessage, maskDiscordWebhookUrl, sendDiscord, validateDiscordWebhookUrl } from '../lib/discord-webhook.mjs';
import { createVapidKeys, decryptPushPayload, encryptPushPayload, sendPush, vapidAuthorization, validatePushSubscription } from '../lib/web-push.mjs';
import { AlertNotifier } from '../lib/alert-notifier.mjs';

// RFC 8291 section 5 and Appendix A.
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};
const WEBHOOK = `https://discord.com/api/webhooks/123456789012345678/${'a'.repeat(68)}`;
const rfcSubscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: RFC.uaPublic, auth: RFC.auth } };

test('web push: RFC 8291 Appendix A vector, round trip and subscription checks', () => {
  const body = encryptPushPayload(rfcSubscription, RFC.plaintext, { sender: RFC.asPrivate, salt: Buffer.from(RFC.salt, 'base64url') });
  assert.equal(body.toString('base64url'), RFC.body);
  assert.equal(decryptPushPayload(Buffer.from(RFC.body, 'base64url'), { privateKey: RFC.uaPrivate, auth: RFC.auth }), RFC.plaintext);
  // Fresh salt and sender key each time, still readable by the user agent.
  const fresh = encryptPushPayload(rfcSubscription, '{"title":"x"}');
  assert.notEqual(fresh.subarray(0, 16).toString('hex'), Buffer.from(RFC.salt, 'base64url').toString('hex'));
  assert.equal(decryptPushPayload(fresh, { privateKey: RFC.uaPrivate, auth: RFC.auth }), '{"title":"x"}');
  assert.throws(() => encryptPushPayload(rfcSubscription, 'x'.repeat(4000)), { code: 'PUSH_PAYLOAD_TOO_LARGE' });
  for (const endpoint of ['http://fcm.googleapis.com/x', 'https://evil.example/x', 'https://127.0.0.1/x', 'https://fcm.googleapis.com:8443/x', 'https://notify.windows.com.evil.example/x', 'https://user:pw@fcm.googleapis.com/x'])
    assert.throws(() => validatePushSubscription({ ...rfcSubscription, endpoint }), /PUSH_(ENDPOINT_INVALID|SERVICE_NOT_ALLOWED)/, endpoint);
  for (const endpoint of ['https://updates.push.services.mozilla.com/wpush/v2/x', 'https://web.push.apple.com/QK', 'https://wns2-par02p.notify.windows.com/w/?token=x']) assert.ok(validatePushSubscription({ ...rfcSubscription, endpoint }).endpoint, endpoint);
  assert.throws(() => validatePushSubscription({ ...rfcSubscription, keys: { p256dh: Buffer.alloc(65, 4).toString('base64url'), auth: RFC.auth } }), { code: 'PUSH_KEYS_INVALID' }, 'not a curve point');
  assert.throws(() => validatePushSubscription({ ...rfcSubscription, keys: { p256dh: RFC.uaPublic, auth: 'short' } }), { code: 'PUSH_KEYS_INVALID' });
});

test('web push: VAPID per RFC 8292 (ES256, aud = push origin, exp <= 24 h)', async () => {
  const keys = createVapidKeys(), now = Date.UTC(2026, 10, 5, 12);
  const header = vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', keys, { subject: 'mailto:ops@example.org', now, ttlSeconds: 48 * 3600 });
  const [, token, k] = /^vapid t=([^,]+), k=(.+)$/.exec(header);
  assert.equal(k, keys.publicKey);
  const [h, c, s] = token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { typ: 'JWT', alg: 'ES256' });
  const claims = JSON.parse(Buffer.from(c, 'base64url'));
  assert.deepEqual(claims, { aud: 'https://fcm.googleapis.com', exp: now / 1000 + 24 * 3600, sub: 'mailto:ops@example.org' });
  const point = Buffer.from(keys.publicKey, 'base64url');
  const publicKey = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.equal(Buffer.from(s, 'base64url').length, 64, 'raw r||s signature');
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')));
  assert.throws(() => vapidAuthorization('https://fcm.googleapis.com/x', keys, { subject: 'ops@example.org' }), { code: 'VAPID_SUBJECT_INVALID' });

  const seen = [];
  const fetchImpl = async (url, options) => { seen.push({ url, options }); return new Response(null, { status: seen.length === 1 ? 201 : 410 }); };
  assert.deepEqual(await sendPush(rfcSubscription, { title: 't' }, { keys, subject: 'mailto:a@b.de', fetchImpl }), { ok: true, status: 201 });
  assert.equal(seen[0].options.redirect, 'error');
  assert.equal(seen[0].options.headers['Content-Encoding'], 'aes128gcm');
  assert.match(seen[0].options.headers.Authorization, /^vapid t=/);
  assert.equal(decryptPushPayload(seen[0].options.body, { privateKey: RFC.uaPrivate, auth: RFC.auth }), '{"title":"t"}');
  assert.equal((await sendPush(rfcSubscription, 'x', { keys, subject: 'mailto:a@b.de', fetchImpl })).gone, true);
});

test('discord: only discord.com webhooks, masked, no mentions', () => {
  assert.equal(validateDiscordWebhookUrl(` ${WEBHOOK} `), WEBHOOK);
  assert.ok(validateDiscordWebhookUrl(WEBHOOK.replace('discord.com', 'discordapp.com').replace('/api/', '/api/v10/')));
  for (const url of ['http://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz', 'https://discord.com.evil.example/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz', 'https://evil.example/api/webhooks/1/2', `${WEBHOOK}?wait=true`, `${WEBHOOK}#x`, WEBHOOK.replace('discord.com', 'discord.com:8443'), 'https://discord.com/api/users/@me', 'not a url'])
    assert.throws(() => validateDiscordWebhookUrl(url), /DISCORD_(URL_INVALID|HOST_NOT_ALLOWED)/, url);
  const masked = maskDiscordWebhookUrl(WEBHOOK);
  assert.equal(masked, 'https://discord.com/api/webhooks/1234…/••••aaaa');
  assert.ok(!masked.includes('a'.repeat(10)));
  const message = discordMessage({ title: '@everyone down', body: 'x', severity: 'bad', t: 0 });
  assert.deepEqual(message.allowed_mentions, { parse: [] });
  assert.equal(message.embeds[0].color, 0xd45c5c);
});

test('discord: HTTP against a fake server (status, Retry-After, timeout)', async t => {
  const hits = [];
  let mode = 'ok';
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      hits.push({ method: req.method, url: req.url, type: req.headers['content-type'], body: JSON.parse(body) });
      if (mode === 'ok') { res.writeHead(204); return res.end(); }
      if (mode === 'limited-once' && hits.length === 1) { res.writeHead(429, { 'Retry-After': '1', 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ retry_after: 0.05 })); }
      if (mode === 'limited-long') { res.writeHead(429, { 'Retry-After': '60' }); return res.end('{}'); }
      if (mode === 'redirect') { res.writeHead(302, { Location: 'http://127.0.0.1:1/' }); return res.end(); }
      if (mode === 'slow') return setTimeout(() => { res.writeHead(204); res.end(); }, 500);
      res.writeHead(204); res.end();
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const local = `http://127.0.0.1:${server.address().port}`;
  // Same request, sent to the fake server instead of discord.com.
  const fetchImpl = (url, options) => fetch(url.replace('https://discord.com', local), options);
  const alert = { title: 'srv ist ausgefallen', body: 'Ursache: Absturz', severity: 'bad', t: 0 };
  assert.deepEqual(await sendDiscord(WEBHOOK, alert, { fetchImpl }), { ok: true, status: 204 });
  assert.equal(hits[0].method, 'POST');
  assert.equal(hits[0].url, '/api/webhooks/123456789012345678/' + 'a'.repeat(68));
  assert.equal(hits[0].type, 'application/json');
  assert.equal(hits[0].body.embeds[0].title, 'srv ist ausgefallen');
  hits.length = 0; mode = 'limited-once';
  const waits = [];
  assert.deepEqual(await sendDiscord(WEBHOOK, alert, { fetchImpl, wait: async ms => { waits.push(ms); } }), { ok: true, status: 204 });
  assert.deepEqual(waits, [50], 'retry_after from the body wins over the header');
  hits.length = 0; mode = 'limited-long';
  const limited = await sendDiscord(WEBHOOK, alert, { fetchImpl, wait: async () => assert.fail('no wait for a long Retry-After') });
  assert.deepEqual([limited.ok, limited.code, limited.retryAfterMs], [false, 'DISCORD_RATE_LIMITED', 60000]);
  mode = 'redirect';
  assert.equal((await sendDiscord(WEBHOOK, alert, { fetchImpl })).code, 'DISCORD_NETWORK', 'redirects are not followed');
  mode = 'slow';
  assert.equal((await sendDiscord(WEBHOOK, alert, { fetchImpl, timeoutMs: 100 })).code, 'DISCORD_TIMEOUT');
});

test('alert rules: validation and the repeat brake', async () => {
  assert.deepEqual(validateAlertRules({}), ALERT_DEFAULTS);
  for (const input of [{ enabled: 'yes' }, { diskFreeGb: -1 }, { playersAtLeast: 1.5 }, { repeatMinutes: 1 }, { repeatMinutes: null }]) assert.throws(() => validateAlertRules(input), { code: 'ALERT_SETTINGS_INVALID' }, JSON.stringify(input));
  assert.equal(validateAlertRules({ playersAtLeast: '' }).playersAtLeast, null);
  assert.deepEqual([formatDuration(20e3), formatDuration(5 * 60e3), formatDuration(125 * 60e3)], ['unter 1 min', '5 min', '2 h 5 min']);

  let now = 0, rules = { ...ALERT_DEFAULTS, enabled: true };
  const sent = [];
  const alerts = new MonitorAlerts({ rules: () => rules, send: async alert => { sent.push(alert); }, now: () => now });
  const live = { id: 'a', name: 'Promod', up: false, down: true, downSince: 0, players: [], b3: null };
  const crash = { kind: 'down', id: 'a', cause: { kind: 'crash', hint: ['Speicherfehler.', 'Memory error.'] } };
  await alerts.handleEvent(crash, live);
  assert.deepEqual(sent.map(item => [item.type, item.title, item.body]), [['down', 'Promod ist ausgefallen', 'Ursache: Absturz. Speicherfehler.']]);
  now = 60e3; await alerts.handleEvent({ kind: 'up', id: 'a', downMs: 60e3 }, live);
  assert.deepEqual(sent.at(-1).body, 'Ausfalldauer: 1 min');
  now = 120e3; await alerts.handleEvent({ kind: 'up', id: 'a', downMs: 1 }, live);
  assert.equal(sent.length, 2, 'the all-clear goes out exactly once');
  // Down again inside the brake: held back, then sent when the brake ends if still down.
  now = 5 * 60e3; await alerts.handleEvent({ kind: 'down', id: 'a', cause: { kind: 'unresponsive' } }, live);
  assert.equal(sent.length, 2);
  assert.deepEqual(alerts.state().pending, ['a']);
  now = 20 * 60e3; await alerts.handleTick({ instances: [{ ...live, downSince: 5 * 60e3 }] });
  assert.equal(sent.length, 2, 'still braked');
  now = 31 * 60e3; await alerts.handleTick({ instances: [{ ...live, downSince: 5 * 60e3 }] });
  assert.deepEqual([sent.length, sent.at(-1).type, sent.at(-1).body], [3, 'down', 'Ursache: keine Antwort (seit 26 min)']);
  now = 32 * 60e3; await alerts.handleEvent({ kind: 'up', id: 'a', downMs: 27 * 60e3 }, live);
  assert.equal(sent.at(-1).body, 'Ausfalldauer: 27 min');
  // A recovery inside the brake sends nothing at all.
  now = 33 * 60e3; await alerts.handleEvent({ kind: 'down', id: 'a', cause: { kind: 'crash' } }, live);
  now = 34 * 60e3; await alerts.handleEvent({ kind: 'up', id: 'a', downMs: 60e3 }, live);
  assert.equal(sent.length, 4);
  assert.deepEqual(alerts.state(), { open: [], pending: [] });
  // Planned stops only on request; disabled rules send nothing.
  now = 100 * 60e3; await alerts.handleEvent({ kind: 'down', id: 'b', cause: { kind: 'stopped' } }, live);
  assert.equal(sent.length, 4);
  rules = { ...rules, onPlannedStop: true }; await alerts.handleEvent({ kind: 'down', id: 'b', cause: { kind: 'stopped' } }, { ...live, name: 'Zwei' });
  assert.equal(sent.at(-1).body, 'Ursache: gestoppt');
  rules = { ...rules, enabled: false }; await alerts.handleEvent({ kind: 'down', id: 'c', cause: { kind: 'crash' } }, live);
  assert.equal(sent.length, 5);
});

test('alert rules: disk space, B3 and player thresholds', async () => {
  let now = 0;
  const rules = { ...ALERT_DEFAULTS, enabled: true, diskFreeGb: 5, b3Stopped: true, playersAtLeast: 10 };
  const sent = [];
  const alerts = new MonitorAlerts({ rules: () => rules, send: async alert => { sent.push(alert); }, now: () => now });
  const GB = 1024 ** 3;
  const tick = (freeGb, instance = {}) => alerts.handleTick({ host: { disks: [{ path: '/srv', freeBytes: freeGb * GB }] }, instances: [{ id: 'a', name: 'Promod', up: true, b3: null, players: [], ...instance }] });
  await tick(4);
  await tick(3);
  assert.deepEqual(sent.map(item => [item.type, item.body]), [['disk', '/srv: noch 4,0 GB frei (Schwelle 5 GB)']], 'low disk is reported once while low');
  await tick(5.2); assert.equal(sent.length, 1, 'hysteresis: 5.2 GB is not yet clear');
  await tick(6); assert.equal(sent.at(-1).type, 'disk-ok');
  // B3 never seen running: no alert. Seen running, then stopped while the server answers: alert.
  await tick(50, { b3: false }); assert.equal(sent.length, 2);
  await tick(50, { b3: true }); await tick(50, { b3: false });
  assert.equal(sent.at(-1).title, 'B3 auf Promod ist gestoppt');
  await tick(50, { b3: true }); assert.equal(sent.at(-1).type, 'b3-ok');
  // Player threshold fires on crossing, re-arms below it, respects the brake.
  const players = n => Array.from({ length: n }, (_, i) => ({ name: `p${i}` }));
  await tick(50, { b3: true, players: players(10), map: 'mp_crash' });
  assert.deepEqual([sent.at(-1).type, sent.at(-1).title, sent.at(-1).body], ['players', 'Promod: 10 Spieler online', 'Schwelle 10 erreicht (Map mp_crash)']);
  const count = sent.length;
  await tick(50, { b3: true, players: players(12) }); assert.equal(sent.length, count, 'not again while above');
  await tick(50, { b3: true, players: players(3) }); await tick(50, { b3: true, players: players(11) });
  assert.equal(sent.length, count, 'brake holds within 30 min');
  now = 31 * 60e3; await tick(50, { b3: true, players: players(2) }); await tick(50, { b3: true, players: players(10) });
  assert.equal(sent.length, count + 1);
});

test('alert notifier: masked status, 0600 files, push only to eligible users, gone subscriptions dropped', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cod4x-alerts-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const audit = [], requests = [];
  let pushStatus = 201;
  const fetchImpl = async (url, options) => { requests.push({ url, options }); return new Response(null, { status: url.startsWith('https://discord.com') ? 204 : pushStatus }); };
  const eligible = new Set(['phone']);
  const notifier = new AlertNotifier({ directory: dir, fetchImpl, audit: (level, event, details) => audit.push({ level, event, details }), eligible: name => eligible.has(name), now: () => 1000 });
  await notifier.load();
  assert.match(notifier.vapidPublicKey, /^B[A-Za-z0-9_-]{86}$/);
  const status = await notifier.configure({ rules: { enabled: true }, discordUrl: WEBHOOK }, 'boss');
  assert.equal(status.discord.url, maskDiscordWebhookUrl(WEBHOOK));
  assert.ok(!JSON.stringify(status).includes('a'.repeat(20)) && !JSON.stringify(audit).includes('a'.repeat(20)), 'the URL never leaves masked');
  if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(dir, 'alerts.json'))).mode & 0o777, 0o600);
  await assert.rejects(notifier.configure({ discordUrl: 'https://evil.example/api/webhooks/1/2' }), { code: 'DISCORD_HOST_NOT_ALLOWED' });

  await notifier.subscribe('phone', rfcSubscription);
  await notifier.subscribe('other', { ...rfcSubscription, endpoint: 'https://fcm.googleapis.com/fcm/send/other' });
  for (let i = 0; i < 6; i++) await notifier.subscribe('phone', { ...rfcSubscription, endpoint: `https://fcm.googleapis.com/fcm/send/p${i}` });
  assert.equal(notifier.status('phone').push.mine, 5, 'at most 5 devices per user, oldest goes first');
  if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(dir, 'push-subscriptions.json'))).mode & 0o777, 0o600);

  const result = await notifier.send({ key: 'server:a', type: 'down', instanceId: 'a', title: 'Promod ist ausgefallen', body: 'Ursache: Absturz', severity: 'bad' });
  assert.equal(result.discord.ok, true);
  assert.equal(result.push.length, 5, 'only the eligible user gets push');
  assert.ok(requests.every(item => !item.url.includes('/other')));
  const pushBody = requests.find(item => item.url.endsWith('/p5')).options.body;
  assert.deepEqual(Object.keys(JSON.parse(decryptPushPayload(pushBody, { privateKey: RFC.uaPrivate, auth: RFC.auth }))), ['title', 'body', 'type', 'tag', 't']);
  assert.equal(audit.filter(item => item.event === 'alert.sent').length, 6);
  assert.ok(audit.filter(item => item.event.startsWith('alert.')).every(item => !JSON.stringify(item).includes('webhooks')), 'no URL in the audit');

  pushStatus = 410;
  await notifier.send({ key: 'k', type: 'test', title: 't', body: '' });
  assert.equal(notifier.status('phone').push.mine, 0, '410 Gone removes the subscription');
  assert.ok(audit.some(item => item.event === 'alert.failed' && item.details.channel === 'push'));
  assert.equal(await notifier.removeUser('other'), 1);
  // A fresh notifier reads the same files back, key pair unchanged.
  const again = new AlertNotifier({ directory: dir, fetchImpl });
  await again.load();
  assert.equal(again.vapidPublicKey, notifier.vapidPublicKey);
  assert.equal(again.status().discord.configured, true);
  await again.configure({ discordUrl: null });
  assert.equal(again.status().discord.configured, false);
});
