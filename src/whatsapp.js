import { createHmac, timingSafeEqual } from 'node:crypto';
import { config, require_ } from './config.js';

const graph = () => `https://graph.facebook.com/${config.whatsapp.apiVersion}`;

// Meta signs every webhook body with the app secret. Anything unsigned is not from Meta.
export function verifySignature(rawBody, header, appSecret) {
  if (!header || !appSecret || !header.startsWith('sha256=')) return false;
  const expected = Buffer.from(createHmac('sha256', appSecret).update(rawBody).digest('hex'));
  const given = Buffer.from(header.slice('sha256='.length));
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// Meta's one-time check that the webhook URL is ours.
export function verifyChallenge(query, verifyToken) {
  if (query.get('hub.mode') === 'subscribe' && verifyToken && query.get('hub.verify_token') === verifyToken) {
    return query.get('hub.challenge');
  }
  return null;
}

// Flattens a webhook payload into the messages we handle. Status updates (sent, read) are ignored.
export function parseMessages(payload) {
  const out = [];
  for (const entry of payload?.entry || []) {
    for (const change of entry.changes || []) {
      for (const m of change.value?.messages || []) {
        const base = { id: m.id, from: m.from, timestamp: Number(m.timestamp) * 1000 };
        if (m.type === 'text') out.push({ ...base, kind: 'text', text: m.text?.body || '' });
        else if (m.type === 'audio') out.push({ ...base, kind: 'audio', mediaId: m.audio?.id, mimeType: m.audio?.mime_type || 'audio/ogg' });
        else if (m.type === 'interactive' && m.interactive?.type === 'button_reply') {
          out.push({ ...base, kind: 'button', buttonId: m.interactive.button_reply.id, text: m.interactive.button_reply.title });
        } else out.push({ ...base, kind: 'unsupported', type: m.type });
      }
    }
  }
  return out;
}

// Delivery reports for messages we sent: sent, delivered, read, failed (with Meta's reason).
export function parseStatuses(payload) {
  const out = [];
  for (const entry of payload?.entry || []) {
    for (const change of entry.changes || []) {
      for (const s of change.value?.statuses || []) {
        const e = s.errors?.[0];
        out.push({ id: s.id, to: s.recipient_id || '', status: s.status, error: e ? `${e.code} ${e.title || ''} ${e.error_data?.details || ''}`.trim() : null });
      }
    }
  }
  return out;
}

async function call(path, init = {}) {
  require_('whatsapp.token', 'whatsapp.phoneNumberId');
  const res = await fetch(`${graph()}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${config.whatsapp.token}`, ...init.headers },
  });
  if (!res.ok) throw new Error(`WhatsApp API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res;
}

function send(body) {
  return call(`/${config.whatsapp.phoneNumberId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...body }),
  }).then((r) => r.json());
}

// Two steps: the media id resolves to a short-lived URL on Meta's CDN, which also needs the token.
export async function downloadMedia(mediaId) {
  const meta = await (await call(`/${mediaId}`)).json();
  const res = await fetch(meta.url, { headers: { Authorization: `Bearer ${config.whatsapp.token}` } });
  if (!res.ok) throw new Error(`media download ${res.status}`);
  return { data: Buffer.from(await res.arrayBuffer()), mimeType: meta.mime_type };
}

export function sendText(to, text) {
  return send({ to, type: 'text', text: { body: text, preview_url: false } });
}

// Up to 3 tap buttons, ids come back in parseMessages as buttonId.
export function sendButtons(to, text, buttons) {
  return send({
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text },
      action: { buttons: buttons.slice(0, 3).map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title.slice(0, 20) } })) },
    },
  });
}

async function upload(data, type, name) {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', type);
  form.append('file', new Blob([data], { type }), name);
  const { id } = await (await call(`/${config.whatsapp.phoneNumberId}/media`, { method: 'POST', body: form })).json();
  return id;
}

export async function sendImage(to, jpg, caption = '') {
  const id = await upload(jpg, 'image/jpeg', 'options.jpg');
  return send({ to, type: 'image', image: { id, ...(caption ? { caption } : {}) } });
}

// WhatsApp Cloud API audio messages have no caption, so the caption goes as a text after it.
export async function sendVoice(to, ogg, caption = '') {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', 'audio/ogg');
  form.append('file', new Blob([ogg], { type: 'audio/ogg' }), 'reply.ogg');
  const { id } = await (await call(`/${config.whatsapp.phoneNumberId}/media`, { method: 'POST', body: form })).json();
  const sent = await send({ to, type: 'audio', audio: { id, voice: true } });
  if (caption) await sendText(to, caption);
  return sent;
}
