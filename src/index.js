/**
 * 棉花糖机 · Cloudflare Workers 后台任务中继
 *
 * 兼容现有 PWA 客户端接口：/health、POST/GET/DELETE /jobs/:id
 * 与 Node 自建版的差异：支持每个任务携带 upstream（baseUrl + apiKey），
 * 因此 App 切换 API 线路时不必改 Worker Secret。
 */

import {
  chatIdFromTaskKey,
  deletePushSubscription,
  ensureVapidKeys,
  notifyJobFinished,
  savePushSubscription,
} from './push.js';

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'expired']);

export default {
  async fetch(request, env, ctx) {
    try {
      return await handleFetch(request, env, ctx);
    } catch (error) {
      return json(500, {
        error: {
          code: 'internal_error',
          message: error?.message || 'Internal error',
        },
      }, corsHeaders(request, env));
    }
  },

  async queue(batch, env) {
    for (const message of batch.messages) {
      try {
        await executeJob(String(message.body?.jobId || ''), env);
        message.ack();
      } catch (_) {
        message.retry();
      }
    }
  },

  async scheduled(_event, env) {
    await dispatchDueSchedules(env);
    await cleanupExpired(env);
  },
};

async function handleFetch(request, env, ctx) {
  const url = new URL(request.url);
  const cors = corsHeaders(request, env);
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  if (url.pathname === '/health' && request.method === 'GET') {
    return json(200, {
      ok: true,
      kind: 'cloudflare-workers',
      version: 3,
      supportsDynamicUpstream: true,
      supportsPush: true,
      supportsCryptoCheck: true,
      crypto: {
        v: 1,
        required: true,
        cipher: 'AES-256-GCM',
        kdf: 'HKDF-SHA256',
      },
    }, cors);
  }

  if (url.pathname === '/setup' && request.method === 'GET') {
    return setupPage(request, env, cors);
  }

  if (url.pathname === '/setup.json' && request.method === 'GET') {
    if (!authorize(request, env)) {
      return json(401, { error: { code: 'unauthorized', message: 'Invalid token' } }, cors);
    }
    return json(200, buildImportPayload(request, env), cors);
  }

  if (!authorize(request, env)) {
    return json(401, { error: { code: 'unauthorized', message: 'Invalid token' } }, cors);
  }

  if (url.pathname === '/crypto-check' && request.method === 'POST') {
    return cryptoCheck(request, env, cors);
  }

  if (url.pathname === '/jobs' && request.method === 'POST') {
    return createJob(request, env, ctx, cors);
  }

  if (url.pathname === '/schedules' && request.method === 'POST') {
    return upsertSchedule(request, env, cors);
  }

  if (url.pathname === '/schedules' && request.method === 'GET') {
    const rows = await env.DB.prepare(
      'SELECT task_key, task_type, revision, run_at, interval_ms, enabled, last_job_id, last_run_at, updated_at FROM schedules ORDER BY run_at ASC',
    ).all();
    const schedules = [];
    for (const row of rows.results || []) {
      let lastJobStatus = '';
      if (row.last_job_id) {
        const job = await env.DB.prepare(
          'SELECT status FROM jobs WHERE id = ?',
        ).bind(row.last_job_id).first();
        lastJobStatus = String(job?.status || '');
      }
      schedules.push(publicSchedule(row, { lastJobStatus }));
    }
    return json(200, { schedules }, cors);
  }

  if (url.pathname === '/push/vapid-public-key' && request.method === 'GET') {
    const vapid = await ensureVapidKeys(env);
    return json(200, { publicKey: vapid.publicKey }, cors);
  }
  if (url.pathname === '/push/subscriptions' && request.method === 'POST') {
    let body;
    try {
      body = await readJson(request, configNumber(env, 'MAX_BODY_BYTES', 64 * 1024));
    } catch (error) {
      return json(error.status || 400, {
        error: { code: 'bad_request', message: error.message },
      }, cors);
    }
    if (
      typeof body?.endpoint !== 'string'
      || typeof body?.keys?.p256dh !== 'string'
      || typeof body?.keys?.auth !== 'string'
    ) {
      return json(400, {
        error: { code: 'invalid_subscription', message: 'Invalid push subscription' },
      }, cors);
    }
    await savePushSubscription(env, body);
    return json(201, { ok: true }, cors);
  }
  if (url.pathname === '/push/subscriptions' && request.method === 'DELETE') {
    let body;
    try {
      body = await readJson(request, configNumber(env, 'MAX_BODY_BYTES', 64 * 1024));
    } catch (error) {
      return json(error.status || 400, {
        error: { code: 'bad_request', message: error.message },
      }, cors);
    }
    await deletePushSubscription(env, body?.endpoint);
    return json(200, { ok: true }, cors);
  }

  const scheduleMatch = url.pathname.match(/^\/schedules\/([^/]+)$/);
  if (scheduleMatch && request.method === 'DELETE') {
    const taskKey = decodeURIComponent(scheduleMatch[1]);
    await env.DB.prepare('DELETE FROM schedules WHERE task_key = ?').bind(taskKey).run();
    return json(200, { ok: true, taskKey }, cors);
  }

  if (url.pathname === '/events' && request.method === 'GET') {
    const after = Math.max(0, Number(url.searchParams.get('after')) || 0);
    const rows = await env.DB.prepare(`
      SELECT * FROM jobs
      WHERE task_key IS NOT NULL
        AND status IN ('succeeded', 'failed', 'cancelled', 'expired')
        AND updated_at > ?
      ORDER BY updated_at ASC
      LIMIT 100
    `).bind(after).all();
    return json(200, {
      events: (rows.results || []).map(publicJob),
      cursor: (rows.results || []).reduce(
        (max, row) => Math.max(max, Number(row.updated_at || 0)),
        after,
      ),
    }, cors);
  }

  const jobMatch = url.pathname.match(/^\/jobs\/([^/]+)$/);
  if (jobMatch) {
    const id = decodeURIComponent(jobMatch[1]);
    if (request.method === 'GET') {
      const job = await getPublicJob(env, id);
      if (!job) return json(404, { error: { code: 'not_found', message: 'Job not found' } }, cors);
      return json(200, job, cors);
    }
    if (request.method === 'DELETE') {
      const changed = await cancelJob(env, id);
      const job = await getPublicJob(env, id);
      if (!job) return json(404, { error: { code: 'not_found', message: 'Job not found' } }, cors);
      return json(200, { ...job, cancelled: changed }, cors);
    }
    if (request.method === 'PATCH') {
      const now = Date.now();
      await env.DB.prepare(
        'UPDATE jobs SET applied_at = ?, updated_at = ? WHERE id = ?',
      ).bind(now, now, id).run();
      const job = await getPublicJob(env, id);
      if (!job) return json(404, { error: { code: 'not_found', message: 'Job not found' } }, cors);
      return json(200, job, cors);
    }
  }

  return json(404, { error: { code: 'not_found', message: 'Not found' } }, cors);
}

function authorize(request, env) {
  const expected = String(env.ADMIN_TOKEN || '');
  if (!expected || expected.length < 16) return false;
  const header = request.headers.get('authorization') || '';
  if (!header.startsWith('Bearer ')) return false;
  return timingSafeEqual(header.slice(7), expected);
}

/** App「测试连接」用的加密往返：验证 ADMIN_TOKEN 与信封加解密是否一致。 */
async function cryptoCheck(request, env, cors) {
  let body;
  try {
    body = await readJson(request, 64 * 1024);
  } catch (error) {
    return json(error.status || 400, {
      error: { code: 'bad_request', message: error.message },
    }, cors);
  }
  const binding = String(body?.binding || body?.nonce || '').trim();
  if (!binding || !body?.envelope) {
    return json(400, {
      error: { code: 'bad_request', message: 'crypto-check requires envelope and binding' },
    }, cors);
  }
  let payload;
  try {
    payload = await decryptEnvelope(body.envelope, env, 'crypto-check', binding);
  } catch (_) {
    return json(400, {
      error: {
        code: 'crypto_mismatch',
        message: 'Encrypted payload could not be opened with ADMIN_TOKEN',
      },
    }, cors);
  }
  const ping = String(payload?.ping || '');
  const reply = {
    ok: true,
    pong: ping,
    nonce: binding,
    serverAt: Date.now(),
  };
  const envelope = await encryptEnvelope(reply, env, 'crypto-check-result', binding);
  return json(200, { ok: true, envelope }, cors);
}

function timingSafeEqual(a, b) {
  const left = new TextEncoder().encode(String(a));
  const right = new TextEncoder().encode(String(b));
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left[i] ^ right[i];
  return diff === 0;
}

function corsHeaders(request, env) {
  const allowlist = String(env.CORS_ALLOWLIST || '*')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const origin = request.headers.get('Origin') || '';
  const allowOrigin = allowlist.includes('*')
    ? '*'
    : (allowlist.includes(origin) ? origin : allowlist[0] || '*');
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Idempotency-Key',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...headers,
    },
  });
}

function html(status, body, headers = {}) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      ...headers,
    },
  });
}

function configNumber(env, key, fallback) {
  const value = Number(env[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function boundedTtl(value, fallback, maximum) {
  if (value == null || value === '') return fallback;
  const num = Number(value);
  if (!Number.isInteger(num) || num < 30 || num > maximum) return null;
  return num;
}

async function readJson(request, maxBytes) {
  const text = await request.text();
  if (text.length > maxBytes) {
    const error = new Error('Request body is too large');
    error.status = 413;
    throw error;
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    const error = new Error('Request body must be valid JSON');
    error.status = 400;
    throw error;
  }
}

function validateCompletionRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return 'request must be an object';
  }
  if (typeof value.model !== 'string' || !value.model.trim()) {
    return 'request.model is required';
  }
  if (!Array.isArray(value.messages) || value.messages.length === 0) {
    return 'request.messages must be a non-empty array';
  }
  return null;
}

function validateUpstream(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return 'upstream must be an object with baseUrl and apiKey';
  }
  const baseUrl = String(value.url || value.baseUrl || '').trim().replace(/\/+$/, '');
  const apiKey = String(value.apiKey || '').trim();
  if (!/^https?:\/\//i.test(baseUrl)) return 'upstream.url must be http(s)';
  if (!apiKey) return 'upstream.apiKey is required';
  return null;
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function base64UrlToBytes(value) {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4 || 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function deriveEnvelopeKey(env) {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(String(env.ADMIN_TOKEN || '')),
    'HKDF',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey({
    name: 'HKDF',
    hash: 'SHA-256',
    salt: new TextEncoder().encode('marshmallow-relay-v1'),
    info: new TextEncoder().encode('task-envelope'),
  }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

function envelopeAad(purpose, binding = '') {
  return new TextEncoder().encode(`mmrelay:v1:${purpose}:${String(binding || '')}`);
}

async function decryptEnvelope(envelope, env, purpose, binding = '') {
  if (!envelope || envelope.v !== 1 || envelope.alg !== 'A256GCM') {
    throw new Error('Unsupported encrypted envelope');
  }
  const key = await deriveEnvelopeKey(env);
  const plain = await crypto.subtle.decrypt({
    name: 'AES-GCM',
    iv: base64UrlToBytes(envelope.iv),
    additionalData: envelopeAad(purpose, binding),
  }, key, base64UrlToBytes(envelope.ciphertext));
  return JSON.parse(new TextDecoder().decode(plain));
}

async function encryptEnvelope(value, env, purpose, binding = '') {
  const key = await deriveEnvelopeKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({
    name: 'AES-GCM',
    iv,
    additionalData: envelopeAad(purpose, binding),
  }, key, new TextEncoder().encode(JSON.stringify(value)));
  return {
    v: 1,
    alg: 'A256GCM',
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
  };
}

function publicJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    startedAt: row.started_at ? new Date(row.started_at).toISOString() : null,
    finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
    requestExpiresAt: new Date(row.request_expires_at).toISOString(),
    resultExpiresAt: new Date(row.result_expires_at).toISOString(),
    resultEnvelope: row.result_envelope ? JSON.parse(row.result_envelope) : null,
    errorEnvelope: row.error_envelope ? JSON.parse(row.error_envelope) : null,
    taskType: row.task_type || '',
    taskKey: row.task_key || '',
    revision: Number(row.revision || 0),
    scheduledFor: row.scheduled_for ? new Date(row.scheduled_for).toISOString() : null,
    appliedAt: row.applied_at ? new Date(row.applied_at).toISOString() : null,
  };
}

async function getPublicJob(env, id) {
  const row = await env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(id).first();
  return publicJob(row);
}

function publicSchedule(row, extras = {}) {
  return {
    taskKey: row.task_key,
    taskType: row.task_type,
    revision: Number(row.revision || 0),
    runAt: new Date(row.run_at).toISOString(),
    intervalMs: row.interval_ms == null ? null : Number(row.interval_ms),
    enabled: Number(row.enabled) === 1,
    lastJobId: row.last_job_id || '',
    lastJobStatus: String(extras.lastJobStatus || ''),
    lastRunAt: row.last_run_at ? new Date(row.last_run_at).toISOString() : null,
    updatedAt: new Date(row.updated_at).toISOString(),
    chatId: chatIdFromTaskKey(row.task_key),
  };
}

async function upsertSchedule(request, env, cors) {
  const maxBytes = configNumber(env, 'MAX_BODY_BYTES', 2 * 1024 * 1024);
  let body;
  try {
    body = await readJson(request, maxBytes);
  } catch (error) {
    return json(error.status || 400, {
      error: { code: 'bad_request', message: error.message },
    }, cors);
  }
  const taskKey = String(body.taskKey || '').trim();
  const taskType = String(body.taskType || '').trim();
  const revision = Math.max(1, Number(body.revision) || 0);
  const runAt = Number(body.runAt) || 0;
  const intervalMs = body.intervalMs == null
    ? null
    : Math.max(60_000, Number(body.intervalMs) || 0);
  if (!taskKey || !taskType || !runAt || runAt < Date.now() - 60_000) {
    return json(400, {
      error: { code: 'bad_schedule', message: 'taskKey, taskType and a future runAt are required' },
    }, cors);
  }
  let payload;
  try {
    payload = await decryptEnvelope(
      body.envelope,
      env,
      'request',
      `${taskKey}:${revision}`,
    );
  } catch (_) {
    return json(400, {
      error: { code: 'invalid_envelope', message: 'Encrypted schedule payload could not be opened' },
    }, cors);
  }
  const requestError = validateCompletionRequest(payload?.request);
  const upstreamError = validateUpstream(payload?.upstream);
  if (requestError || upstreamError) {
    return json(400, {
      error: { code: 'bad_request', message: requestError || upstreamError },
    }, cors);
  }
  const defaultRequestTtl = configNumber(env, 'DEFAULT_REQUEST_TTL_SECONDS', 900);
  const defaultResultTtl = configNumber(env, 'DEFAULT_RESULT_TTL_SECONDS', 3600);
  const requestTtl = boundedTtl(body.requestTtlSeconds, defaultRequestTtl, 86400);
  const resultTtl = boundedTtl(body.resultTtlSeconds, defaultResultTtl, 604800);
  if (requestTtl == null || resultTtl == null) {
    return json(400, {
      error: { code: 'bad_request', message: 'TTL out of allowed range' },
    }, cors);
  }
  const now = Date.now();
  const requestHash = await sha256Hex(canonicalJson(payload));
  if (body.requestHash && String(body.requestHash) !== requestHash) {
    return json(400, {
      error: { code: 'hash_mismatch', message: 'Encrypted schedule hash does not match payload' },
    }, cors);
  }
  await env.DB.prepare(`
    INSERT INTO schedules (
      task_key, task_type, revision, run_at, interval_ms, request_hash,
      request_envelope, request_ttl_seconds, result_ttl_seconds,
      enabled, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(task_key) DO UPDATE SET
      task_type = excluded.task_type,
      revision = excluded.revision,
      run_at = excluded.run_at,
      interval_ms = excluded.interval_ms,
      request_hash = excluded.request_hash,
      request_envelope = excluded.request_envelope,
      request_ttl_seconds = excluded.request_ttl_seconds,
      result_ttl_seconds = excluded.result_ttl_seconds,
      enabled = 1,
      updated_at = excluded.updated_at
    WHERE excluded.revision >= schedules.revision
  `).bind(
    taskKey,
    taskType,
    revision,
    runAt,
    intervalMs,
    requestHash,
    JSON.stringify(body.envelope),
    requestTtl,
    resultTtl,
    now,
    now,
  ).run();
  await env.DB.prepare(`
    UPDATE jobs SET
      status = 'cancelled',
      finished_at = ?,
      updated_at = ?,
      request_envelope = NULL
    WHERE task_key = ? AND revision < ? AND status = 'queued'
  `).bind(now, now, taskKey, revision).run();
  const row = await env.DB.prepare(
    'SELECT * FROM schedules WHERE task_key = ?',
  ).bind(taskKey).first();
  return json(200, publicSchedule(row), cors);
}

async function dispatchDueSchedules(env) {
  const now = Date.now();
  const due = await env.DB.prepare(`
    SELECT * FROM schedules
    WHERE enabled = 1 AND run_at <= ?
    ORDER BY run_at ASC
    LIMIT 50
  `).bind(now).all();
  for (const schedule of due.results || []) {
    const active = await env.DB.prepare(`
      SELECT id FROM jobs
      WHERE task_key = ? AND status IN ('queued', 'running')
      LIMIT 1
    `).bind(schedule.task_key).first();
    const pending = await env.DB.prepare(`
      SELECT COUNT(*) AS count FROM jobs
      WHERE task_key = ? AND status = 'succeeded' AND applied_at IS NULL
    `).bind(schedule.task_key).first();
    if (active || Number(pending?.count || 0) >= 20) {
      const postpone = now + Math.max(60_000, Number(schedule.interval_ms) || 300_000);
      await env.DB.prepare(
        'UPDATE schedules SET run_at = ?, updated_at = ? WHERE task_key = ? AND revision = ?',
      ).bind(postpone, now, schedule.task_key, schedule.revision).run();
      continue;
    }
    const idempotencyKey = `schedule:${schedule.task_key}:${schedule.revision}:${schedule.run_at}`;
    const existing = await env.DB.prepare(
      'SELECT id FROM jobs WHERE idempotency_key = ?',
    ).bind(idempotencyKey).first();
    let jobId = existing?.id || '';
    if (!jobId) {
      jobId = `job_${now.toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
      await env.DB.prepare(`
        INSERT INTO jobs (
          id, idempotency_key, request_hash, request_envelope, status,
          task_type, task_key, revision, scheduled_for,
          created_at, updated_at, request_expires_at,
          result_ttl_seconds, result_expires_at
        ) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        jobId,
        idempotencyKey,
        schedule.request_hash,
        schedule.request_envelope,
        schedule.task_type,
        schedule.task_key,
        schedule.revision,
        schedule.run_at,
        now,
        now,
        now + Number(schedule.request_ttl_seconds || 900) * 1000,
        Number(schedule.result_ttl_seconds || 3600),
        now + Number(schedule.result_ttl_seconds || 3600) * 1000,
      ).run();
      await env.JOB_QUEUE.send({ jobId });
    }
    const nextRunAt = schedule.interval_ms
      ? Math.max(now + 60_000, schedule.run_at + Number(schedule.interval_ms))
      : schedule.run_at;
    await env.DB.prepare(`
      UPDATE schedules SET
        enabled = ?,
        run_at = ?,
        last_job_id = ?,
        last_run_at = ?,
        updated_at = ?
      WHERE task_key = ? AND revision = ?
    `).bind(
      schedule.interval_ms ? 1 : 0,
      nextRunAt,
      jobId,
      now,
      now,
      schedule.task_key,
      schedule.revision,
    ).run();
  }
}

async function createJob(request, env, ctx, cors) {
  const maxBytes = configNumber(env, 'MAX_BODY_BYTES', 2 * 1024 * 1024);
  let body;
  try {
    body = await readJson(request, maxBytes);
  } catch (error) {
    return json(error.status || 400, {
      error: { code: 'bad_request', message: error.message },
    }, cors);
  }

  const defaultRequestTtl = configNumber(env, 'DEFAULT_REQUEST_TTL_SECONDS', 900);
  const defaultResultTtl = configNumber(env, 'DEFAULT_RESULT_TTL_SECONDS', 3600);
  const requestTtl = boundedTtl(body.requestTtlSeconds, defaultRequestTtl, 86400);
  const resultTtl = boundedTtl(body.resultTtlSeconds, defaultResultTtl, 604800);
  if (requestTtl == null || resultTtl == null) {
    return json(400, {
      error: { code: 'bad_request', message: 'TTL out of allowed range' },
    }, cors);
  }

  const idempotencyKey = String(
    request.headers.get('Idempotency-Key') || body.clientTaskId || '',
  ).trim() || null;
  const binding = idempotencyKey || String(body.clientTaskId || '');
  let payload;
  try {
    payload = await decryptEnvelope(body.envelope, env, 'request', binding);
  } catch (_) {
    return json(400, {
      error: { code: 'invalid_envelope', message: 'Encrypted task payload could not be opened' },
    }, cors);
  }
  const requestError = validateCompletionRequest(payload?.request);
  const upstreamError = validateUpstream(payload?.upstream);
  if (requestError || upstreamError) {
    return json(400, {
      error: { code: 'bad_request', message: requestError || upstreamError },
    }, cors);
  }
  const requestHash = await sha256Hex(canonicalJson(payload));
  if (body.requestHash && String(body.requestHash) !== requestHash) {
    return json(400, {
      error: { code: 'hash_mismatch', message: 'Encrypted task hash does not match payload' },
    }, cors);
  }

  if (idempotencyKey) {
    const existing = await env.DB.prepare(
      'SELECT * FROM jobs WHERE idempotency_key = ?',
    ).bind(idempotencyKey).first();
    if (existing) {
      if (existing.request_hash !== requestHash) {
        return json(409, {
          error: { code: 'idempotency_conflict', message: 'Idempotency-Key reused with different body' },
        }, cors);
      }
      return json(202, publicJob(existing), cors);
    }
  }

  const now = Date.now();
  const id = `job_${now.toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
  const requestExpiresAt = now + requestTtl * 1000;
  const resultExpiresAt = now + resultTtl * 1000;

  try {
    await env.DB.prepare(`
      INSERT INTO jobs (
        id, idempotency_key, request_hash, request_envelope, status,
        task_type, task_key, revision, scheduled_for,
        created_at, updated_at, request_expires_at, result_ttl_seconds, result_expires_at
      ) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      idempotencyKey,
      requestHash,
      JSON.stringify(body.envelope),
      String(body.taskType || ''),
      String(body.taskKey || '') || null,
      Math.max(0, Number(body.revision) || 0),
      Number(body.scheduledFor) || null,
      now,
      now,
      requestExpiresAt,
      resultTtl,
      resultExpiresAt,
    ).run();
  } catch (error) {
    if (String(error?.message || '').includes('UNIQUE')) {
      const existing = await env.DB.prepare(
        'SELECT * FROM jobs WHERE idempotency_key = ?',
      ).bind(idempotencyKey).first();
      if (existing) return json(202, publicJob(existing), cors);
    }
    throw error;
  }

  await env.JOB_QUEUE.send({ jobId: id });
  ctx.waitUntil(cleanupExpired(env).catch(() => {}));
  const created = await getPublicJob(env, id);
  return json(202, created, cors);
}

async function cancelJob(env, id) {
  const now = Date.now();
  const result = await env.DB.prepare(`
    UPDATE jobs
    SET status = 'cancelled',
        finished_at = ?,
        updated_at = ?,
        request_envelope = NULL
    WHERE id = ? AND status IN ('queued', 'running')
  `).bind(now, now, id).run();
  return Number(result?.meta?.changes || 0) > 0;
}

async function executeJob(jobId, env) {
  if (!jobId) return;
  const row = await env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(jobId).first();
  if (!row || row.status !== 'queued') return;
  if (row.request_expires_at <= Date.now()) {
    await finishJob(env, jobId, 'expired', {
      error: { code: 'expired', message: 'Request TTL expired before execution' },
    });
    return;
  }

  const claimed = await env.DB.prepare(`
    UPDATE jobs SET status = 'running', started_at = ?, updated_at = ?
    WHERE id = ? AND status = 'queued'
  `).bind(Date.now(), Date.now(), jobId).run();
  if (!Number(claimed?.meta?.changes || 0)) return;

  let payload;
  try {
    const envelope = JSON.parse(row.request_envelope || 'null');
    payload = await decryptEnvelope(
      envelope,
      env,
      'request',
      row.task_key
        ? `${row.task_key}:${Number(row.revision || 0)}`
        : (row.idempotency_key || ''),
    );
  } catch {
    await finishJob(env, jobId, 'failed', {
      error: { code: 'corrupt_job', message: 'Stored job payload is invalid' },
    });
    return;
  }
  const request = payload?.request;
  const upstream = payload?.upstream;
  if (validateCompletionRequest(request) || validateUpstream(upstream)) {
    await finishJob(env, jobId, 'failed', {
      error: { code: 'missing_payload', message: 'Job payload missing' },
    });
    return;
  }

  const remaining = Math.max(1, row.request_expires_at - Date.now());
  const timeoutMs = Math.min(remaining, 14 * 60 * 1000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const upstreamUrl = String(upstream.url || '').trim()
      || `${String(upstream.baseUrl || '').replace(/\/+$/, '')}/chat/completions`;
    const response = await fetch(upstreamUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${upstream.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(upstream.customHeaders && typeof upstream.customHeaders === 'object'
          ? upstream.customHeaders
          : {}),
      },
      body: JSON.stringify({ ...request, stream: false }),
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch (_) { parsed = null; }

    if (!response.ok) {
      await finishJob(env, jobId, 'failed', {
        error: {
          code: 'upstream_error',
          status: response.status,
          message: typeof parsed?.error?.message === 'string'
            ? parsed.error.message.slice(0, 1000)
            : `Upstream returned HTTP ${response.status}`,
        },
      });
      return;
    }
    if (parsed == null) {
      await finishJob(env, jobId, 'failed', {
        error: { code: 'invalid_upstream_response', message: 'Upstream did not return JSON' },
      });
      return;
    }
    await advanceRecurringScheduleContext(env, row, parsed);
    const resultEnvelope = await encryptEnvelope(parsed, env, 'result', jobId);
    await finishJob(env, jobId, 'succeeded', { resultEnvelope });
  } catch (error) {
    const current = await env.DB.prepare('SELECT status FROM jobs WHERE id = ?').bind(jobId).first();
    if (current?.status !== 'running') return;
    const timedOut = error?.name === 'AbortError';
    await finishJob(env, jobId, 'failed', {
      error: {
        code: timedOut ? 'upstream_timeout' : 'upstream_unavailable',
        message: timedOut ? 'Upstream request timed out' : 'Upstream request failed',
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

function completionText(result) {
  const content = result?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => part?.text || part?.content || '').join('');
  }
  return '';
}

async function advanceRecurringScheduleContext(env, jobRow, result) {
  if (!jobRow?.task_key) return;
  const schedule = await env.DB.prepare(
    'SELECT * FROM schedules WHERE task_key = ? AND revision = ? AND enabled = 1',
  ).bind(jobRow.task_key, jobRow.revision).first();
  if (!schedule?.interval_ms || !schedule.request_envelope) return;
  const text = completionText(result).trim();
  if (!text) return;
  try {
    const envelope = JSON.parse(schedule.request_envelope);
    const binding = `${schedule.task_key}:${Number(schedule.revision || 0)}`;
    const payload = await decryptEnvelope(envelope, env, 'request', binding);
    if (!Array.isArray(payload?.request?.messages)) return;
    const messages = [...payload.request.messages, {
      role: 'assistant',
      content: text,
    }];
    // 防止用户长期不打开 App 时影子上下文无限增长；系统提示保留，近期回合滚动。
    const system = messages.filter((message) => message?.role === 'system');
    const recent = messages.filter((message) => message?.role !== 'system').slice(-40);
    payload.request.messages = [...system.slice(0, 4), ...recent];
    const nextEnvelope = await encryptEnvelope(payload, env, 'request', binding);
    const nextHash = await sha256Hex(canonicalJson(payload));
    await env.DB.prepare(`
      UPDATE schedules
      SET request_envelope = ?, request_hash = ?, updated_at = ?
      WHERE task_key = ? AND revision = ?
    `).bind(
      JSON.stringify(nextEnvelope),
      nextHash,
      Date.now(),
      schedule.task_key,
      schedule.revision,
    ).run();
  } catch (_) {
    // 影子上下文推进失败不影响本轮结果；App 下次活跃时会上传新 revision 覆盖。
  }
}

async function finishJob(env, id, status, { resultEnvelope = null, error = null } = {}) {
  const now = Date.now();
  const row = await env.DB.prepare(
    'SELECT * FROM jobs WHERE id = ?',
  ).bind(id).first();
  if (!row) return;
  const resultTtl = Number(row.result_ttl_seconds || 3600);
  const errorEnvelope = error
    ? await encryptEnvelope(error, env, 'error', id)
    : null;
  await env.DB.prepare(`
    UPDATE jobs SET
      status = ?,
      result_envelope = ?,
      error_envelope = ?,
      finished_at = ?,
      updated_at = ?,
      result_expires_at = ?,
      request_envelope = NULL
    WHERE id = ?
  `).bind(
    status,
    resultEnvelope ? JSON.stringify(resultEnvelope) : null,
    errorEnvelope ? JSON.stringify(errorEnvelope) : null,
    now,
    now,
    now + resultTtl * 1000,
    id,
  ).run();
  // 任务结束后主动 Web Push；App 被杀时 PWA/浏览器仍可能收到，点开后再对账落库。
  await notifyJobFinished(env, row, status).catch(() => {});
}

async function cleanupExpired(env) {
  const now = Date.now();
  await env.DB.prepare(`
    UPDATE jobs SET
      status = 'expired',
      finished_at = COALESCE(finished_at, ?),
      updated_at = ?,
      request_envelope = NULL
    WHERE status IN ('queued', 'running') AND request_expires_at <= ?
  `).bind(now, now, now).run();

  await env.DB.prepare(`
    DELETE FROM jobs
    WHERE result_expires_at <= ?
       OR (status IN ('failed', 'cancelled', 'expired') AND updated_at <= ?)
  `).bind(now, now - 7 * 24 * 60 * 60 * 1000).run();
}

function buildImportPayload(request, env) {
  const url = new URL(request.url);
  const baseUrl = `${url.protocol}//${url.host}`;
  return {
    v: 1,
    kind: 'cloudflare-workers',
    cryptoV: 1,
    baseUrl,
    requestTtlSeconds: configNumber(env, 'DEFAULT_REQUEST_TTL_SECONDS', 900),
    resultTtlSeconds: configNumber(env, 'DEFAULT_RESULT_TTL_SECONDS', 3600),
    enabled: true,
  };
}

function setupPage(request, env, cors) {
  if (!String(env.ADMIN_TOKEN || '')) {
    return html(503, `<!doctype html><meta charset="utf-8"><title>中继未就绪</title>
      <body style="font-family:system-ui;padding:24px;line-height:1.6">
      <h1>中继尚未配置 ADMIN_TOKEN</h1>
      <p>请回到 Cloudflare 部署页填写访问令牌后重新部署。</p>
      </body>`, cors);
  }

  return html(200, `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>棉花糖机中继 · 导入配置</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; padding: 24px; background: #f6f1ea; color: #2c241c; }
    main { max-width: 40rem; margin: 0 auto; background: #fffdf8; border: 1px solid #e4d7c8; border-radius: 16px; padding: 20px; }
    h1 { font-size: 1.25rem; margin: 0 0 8px; }
    p { line-height: 1.55; margin: 0 0 12px; color: #5b4d40; }
    input, textarea { width: 100%; box-sizing: border-box; border-radius: 12px; border: 1px solid #d8c7b5; padding: 12px; font: 14px/1.4 system-ui, sans-serif; }
    textarea { min-height: 8rem; font-family: ui-monospace, monospace; font-size: 12px; margin-top: 12px; }
    button { margin-top: 12px; width: 100%; border: 0; border-radius: 999px; padding: 14px 16px; background: #2c241c; color: #fffdf8; font-size: 1rem; }
    .ok { margin-top: 10px; min-height: 1.2em; color: #2f6b3a; }
  </style>
</head>
<body>
  <main>
    <h1>部署完成</h1>
    <p>输入部署时设置的访问令牌，验证后会在本机生成导入配置。令牌不会放进网址或浏览器历史。</p>
    <input id="token" type="password" autocomplete="off" placeholder="ADMIN_TOKEN" />
    <button type="button" id="generate">验证并生成配置</button>
    <textarea id="cfg" readonly hidden></textarea>
    <button type="button" id="copy" hidden>复制配置</button>
    <div class="ok" id="status" role="status"></div>
  </main>
  <script>
    const cfg = document.getElementById('cfg');
    const status = document.getElementById('status');
    const tokenInput = document.getElementById('token');
    const encode = (payload) => {
      const bytes = new TextEncoder().encode(JSON.stringify(payload));
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return 'mmrelay1.' + btoa(binary).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/g, '');
    };
    document.getElementById('generate').onclick = async () => {
      const token = tokenInput.value.trim();
      if (!token) {
        status.textContent = '请先输入访问令牌';
        return;
      }
      status.textContent = '正在验证…';
      try {
        const response = await fetch('/setup.json', {
          headers: { Authorization: 'Bearer ' + token },
          cache: 'no-store',
        });
        if (!response.ok) throw new Error('访问令牌不正确');
        const payload = await response.json();
        cfg.value = encode({ ...payload, token, enabled: true });
        cfg.hidden = false;
        document.getElementById('copy').hidden = false;
        status.textContent = '配置已生成';
      } catch (error) {
        status.textContent = error.message || '验证失败';
      }
    };
    document.getElementById('copy').onclick = async () => {
      try {
        await navigator.clipboard.writeText(cfg.value);
        status.textContent = '已复制';
      } catch (_) {
        cfg.focus();
        cfg.select();
        status.textContent = '请长按文本手动复制';
      }
    };
  </script>
</body>
</html>`, cors);
}
