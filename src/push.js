/**
 * Cloudflare Workers 侧 Web Push（VAPID + aes128gcm）。
 * 密钥可写在环境变量，也可首次访问时自动生成并落到 D1。
 */

import { buildPushPayload } from '@block65/webcrypto-web-push';

function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value) {
  const padded = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  const raw = atob(padded + pad);
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

async function generateVapidKeys() {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign'],
  );
  const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const x = base64UrlToBytes(publicJwk.x);
  const y = base64UrlToBytes(publicJwk.y);
  const uncompressed = new Uint8Array(65);
  uncompressed[0] = 0x04;
  uncompressed.set(x, 1);
  uncompressed.set(y, 33);
  return {
    publicKey: bytesToBase64Url(uncompressed),
    privateKey: String(privateJwk.d || ''),
  };
}

async function kvGet(env, key) {
  const row = await env.DB.prepare(
    'SELECT value FROM relay_kv WHERE key = ?',
  ).bind(key).first();
  return row?.value ? String(row.value) : '';
}

async function kvSet(env, key, value) {
  const now = Date.now();
  await env.DB.prepare(`
    INSERT INTO relay_kv (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).bind(key, String(value), now).run();
}

export async function ensureVapidKeys(env) {
  const subject = String(env.VAPID_SUBJECT || 'mailto:relay@marshmallow.local');
  let publicKey = String(env.VAPID_PUBLIC_KEY || '').trim();
  let privateKey = String(env.VAPID_PRIVATE_KEY || '').trim();
  if (!publicKey || !privateKey) {
    publicKey = await kvGet(env, 'vapid_public_key');
    privateKey = await kvGet(env, 'vapid_private_key');
  }
  if (!publicKey || !privateKey) {
    const generated = await generateVapidKeys();
    publicKey = generated.publicKey;
    privateKey = generated.privateKey;
    await kvSet(env, 'vapid_public_key', publicKey);
    await kvSet(env, 'vapid_private_key', privateKey);
  }
  return { subject, publicKey, privateKey };
}

export async function listPushSubscriptions(env) {
  const rows = await env.DB.prepare(
    'SELECT subscription_json FROM push_subscriptions ORDER BY created_at ASC',
  ).all();
  return (rows.results || []).map((row) => {
    try { return JSON.parse(row.subscription_json); } catch (_) { return null; }
  }).filter((item) => item?.endpoint && item?.keys?.p256dh && item?.keys?.auth);
}

export async function savePushSubscription(env, subscription) {
  const endpoint = String(subscription?.endpoint || '').trim();
  if (!endpoint) throw new Error('endpoint required');
  const now = Date.now();
  await env.DB.prepare(`
    INSERT INTO push_subscriptions (endpoint, subscription_json, created_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET
      subscription_json = excluded.subscription_json,
      updated_at = excluded.updated_at
  `).bind(endpoint, JSON.stringify(subscription), now, now).run();
}

export async function deletePushSubscription(env, endpoint) {
  const key = String(endpoint || '').trim();
  if (!key) return false;
  const result = await env.DB.prepare(
    'DELETE FROM push_subscriptions WHERE endpoint = ?',
  ).bind(key).run();
  return Number(result?.meta?.changes || 0) > 0;
}

function rewriteVapidAuthorization(headers, publicKey) {
  const next = { ...headers };
  const authKey = Object.keys(next).find((key) => key.toLowerCase() === 'authorization');
  if (!authKey) return next;
  const match = String(next[authKey] || '').match(/^WebPush\s+(.+)$/i);
  if (match) {
    next[authKey] = `vapid t=${match[1].trim()}, k=${publicKey}`;
  }
  return next;
}

export function chatIdFromTaskKey(taskKey = '') {
  const key = String(taskKey || '').trim();
  if (key.startsWith('chat-auto:')) return key.slice('chat-auto:'.length).trim();
  if (key.startsWith('chat-idle:')) return key.slice('chat-idle:'.length).trim();
  if (key.startsWith('chat-delay:')) {
    const body = key.slice('chat-delay:'.length);
    const splitAt = body.lastIndexOf(':');
    return (splitAt > 0 ? body.slice(0, splitAt) : body).trim();
  }
  return '';
}

export async function notifyJobFinished(env, jobRow, status) {
  if (!jobRow || !['succeeded', 'failed', 'expired'].includes(status)) return { sent: 0 };
  const subscriptions = await listPushSubscriptions(env);
  if (!subscriptions.length) return { sent: 0, skipped: true };
  const vapid = await ensureVapidKeys(env);
  const chatId = chatIdFromTaskKey(jobRow.task_key);
  const ok = status === 'succeeded';
  const payloadObject = {
    title: ok ? '角色回消息了' : '后台生成未完成',
    body: ok ? '打开棉花糖机查看' : '打开棉花糖机查看详情',
    tag: chatId ? `mm-chat-${chatId}` : `mm-job-${jobRow.id}`,
    data: {
      chatId,
      remoteJobId: jobRow.id,
      taskKey: jobRow.task_key || '',
      taskType: jobRow.task_type || '',
      status,
      reconcile: true,
    },
  };
  let sent = 0;
  for (const subscription of subscriptions) {
    try {
      const requestInit = await buildPushPayload(
        { data: payloadObject, options: { ttl: 60 * 60, urgency: 'high' } },
        subscription,
        vapid,
      );
      const headers = rewriteVapidAuthorization(requestInit.headers || {}, vapid.publicKey);
      const response = await fetch(subscription.endpoint, {
        ...requestInit,
        headers,
      });
      if (response.status === 404 || response.status === 410) {
        await deletePushSubscription(env, subscription.endpoint);
        continue;
      }
      if (response.ok || response.status === 201) sent += 1;
    } catch (_) {
      // 单个订阅失败不阻断其余设备
    }
  }
  return { sent };
}
