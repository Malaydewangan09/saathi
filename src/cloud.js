import { createGroqAgent } from './groq.js';

const WHISPER_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const AUDIO_TYPES = ['audio/webm', 'audio/mp4', 'audio/ogg', 'audio/mpeg', 'audio/wav'];
const MAX_TEXT = 500;
const MAX_AUDIO_BYTES = 900 * 1024;
const VISITOR = /^[a-z0-9]{16,40}$/;

// Decided in code because the free model does not reliably follow the asker's language.
// Quoted or forwarded text does not count, only the person's own words.
export function replyLanguage(text) {
  const own = String(text).replace(/["“”'‘’][^"“”'‘’]*["“”'‘’]/g, ' ');
  return /[\u0900-\u097F]/.test(own) ? 'Hindi, in Devanagari script' : 'English';
}

// The live web chat without a laptop: one stateless request in, one answer out.
// Limits here are per server instance, a best effort on top of Groq's own rate limits.
export function createCloudChat({ apiKey, origins, perVisitor = 6, fetchImpl = fetch, agent, now = Date.now }) {
  const groq = agent || createGroqAgent({ apiKey, fetchImpl });
  let day = '';
  let counts = new Map();

  function admit(key) {
    const today = new Date(now()).toISOString().slice(0, 10);
    if (today !== day) {
      day = today;
      counts = new Map();
    }
    const n = counts.get(key) || 0;
    if (n >= perVisitor) return false;
    counts.set(key, n + 1);
    return true;
  }

  async function transcribe(data, mime) {
    const form = new FormData();
    form.append('model', 'whisper-large-v3-turbo');
    form.append('response_format', 'json');
    form.append('file', new Blob([data], { type: mime }), `note.${mime.split('/')[1]}`);
    const res = await fetchImpl(WHISPER_URL, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form });
    if (!res.ok) throw new Error(`Groq Whisper ${res.status}`);
    return String((await res.json()).text || '').trim();
  }

  return {
    allowedOrigin: (origin) => Boolean(origin) && origins.includes(origin),

    // Returns [status code, body].
    async ask(body, { ip = '' } = {}) {
      const visitor = String(body?.visitor || '');
      if (!VISITOR.test(visitor)) return [400, { error: 'bad visitor id' }];

      let text = typeof body.text === 'string' ? body.text.trim() : '';
      let audio = null;
      if (text) {
        if (text.length > MAX_TEXT) return [400, { error: `keep it under ${MAX_TEXT} characters` }];
      } else if (typeof body.audio === 'string') {
        const mime = String(body.mime || '').split(';')[0];
        if (!AUDIO_TYPES.includes(mime)) return [400, { error: 'unsupported audio' }];
        audio = Buffer.from(body.audio, 'base64');
        if (!audio.length || audio.length > MAX_AUDIO_BYTES) return [400, { error: 'audio too long' }];
        audio = { data: audio, mime };
      } else return [400, { error: 'send text or audio' }];

      if (!admit(`v:${visitor}`) || (ip && !admit(`ip:${ip}`))) return [429, { error: 'visitor' }];

      try {
        if (audio) text = await transcribe(audio.data, audio.mime);
        if (!text) return [200, { transcript: '', spoken: '', card: '', lang: 'en', empty: true }];
        const language = replyLanguage(text);
        const message = `[Reply in ${language}]\n${text}`;
        let { reply } = await groq.run({ message, language });
        // The free model sometimes answers in the wrong language. Ask once more, then accept what comes.
        const wantHindi = language.startsWith('Hindi');
        if (wantHindi !== /[\u0900-\u097F]/.test(reply.spoken)) ({ reply } = await groq.run({ message, language }));
        const lang = /[\u0900-\u097F]/.test(reply.spoken) ? 'hi' : 'en';
        return [200, { transcript: audio ? text : undefined, spoken: reply.spoken, card: reply.card, lang }];
      } catch (err) {
        const busy = /busy|429/.test(err.message);
        return [busy ? 503 : 502, { error: busy ? 'busy' : 'failed' }];
      }
    },
  };
}
