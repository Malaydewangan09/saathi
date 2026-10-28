import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const MEDIA_TTL_MS = 15 * 60 * 1000;

// Twilio signs the full public URL plus the POST params sorted by name, with HMAC-SHA1 of the auth token.
export function verifyTwilioSignature({ url, params, header, authToken }) {
  if (!header || !authToken) return false;
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  const expected = Buffer.from(createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64'));
  const given = Buffer.from(header);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const number = (addr) => (addr || '').replace(/^whatsapp:/, '').replace(/^\+/, '');

// The sandbox has no tap buttons, so choices are numbered text and replies are mapped back to button ids.
export function createTwilioTransport({ accountSid, authToken, from, publicUrl, fetchImpl = fetch }) {
  const choices = new Map();
  const media = new Map();
  const api = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}`;
  const auth = `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`;

  async function send(to, fields) {
    const res = await fetchImpl(`${api}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ From: from, To: `whatsapp:+${to}`, ...fields }),
    });
    if (!res.ok) throw new Error(`Twilio ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
  }

  function parseMessage(params) {
    const base = { id: params.MessageSid, from: number(params.From), timestamp: Date.now() };
    if (Number(params.NumMedia) > 0) {
      const type = params.MediaContentType0 || '';
      if (type.startsWith('audio/')) return { ...base, kind: 'audio', mediaId: params.MediaUrl0, mimeType: type };
      return { ...base, kind: 'unsupported', type };
    }
    const text = (params.Body || '').trim();
    const offered = choices.get(base.from);
    if (offered) {
      const said = text.toLowerCase().replace(/[.!।]+$/, '');
      const i = /^\d+$/.test(said) ? Number(said) - 1 : offered.findIndex((b) => [b.title, ...(b.aliases || [])].some((t) => t.toLowerCase() === said));
      if (offered[i]) {
        choices.delete(base.from);
        return { ...base, kind: 'button', buttonId: offered[i].id, text: offered[i].title };
      }
    }
    return { ...base, kind: 'text', text };
  }

  return {
    parseMessage,

    sendText: (to, text) => send(to, { Body: text }),

    sendButtons(to, text, buttons) {
      choices.set(to, buttons);
      const list = buttons.map((b, i) => `${i + 1}. ${b.title}`).join('\n');
      return send(to, { Body: `${text}\n\n${list}\n\n(Reply with the number)` });
    },

    // Twilio fetches media from a URL, so the voice note is served by this server for a short time.
    sendVoice(to, ogg) {
      const id = randomBytes(16).toString('hex');
      media.set(id, { data: ogg, expires: Date.now() + MEDIA_TTL_MS });
      return send(to, { MediaUrl: `${publicUrl}/media/${id}.ogg` });
    },

    getMedia(id) {
      const m = media.get(id);
      if (!m || m.expires < Date.now()) {
        media.delete(id);
        return null;
      }
      return m.data;
    },

    // Incoming media URLs need the account credentials and redirect to storage.
    async downloadMedia(url) {
      if (!url.startsWith('https://api.twilio.com/')) throw new Error('unexpected media host');
      const res = await fetchImpl(url, { headers: { Authorization: auth }, redirect: 'follow' });
      if (!res.ok) throw new Error(`Twilio media ${res.status}`);
      return { data: Buffer.from(await res.arrayBuffer()), mimeType: res.headers.get('content-type') || 'audio/ogg' };
    },
  };
}
