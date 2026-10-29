import { createHandler } from './handler.js';
import { Store } from './store.js';
import { createGroqAgent } from './groq.js';
import { createWebChannel, MAX_AUDIO_BYTES, MAX_TEXT, VISITOR } from './web.js';

const AUDIO_TYPES = ['audio/webm', 'audio/mp4', 'audio/ogg', 'audio/mpeg', 'audio/wav'];
const MAX_BODY = Math.ceil((MAX_AUDIO_BYTES * 4) / 3) + 4096;

// Routes for the public "Try it live" chat. Answers come from Groq with web search, never the Claude login.
export function createWebApi({ web: cfg, voice, readBody, track, log = console, agent, channel }) {
  const web = channel || createWebChannel({ perVisitor: cfg.perVisitor, perDay: cfg.perDay });
  const store = new Store('/dev/null/web');
  store.save = async () => {};
  const handle = createHandler({
    store,
    wa: web.transport,
    agent: agent || createGroqAgent({ apiKey: cfg.groqKey }),
    voice,
    numbers: (n) => n.startsWith('web:'),
    log,
  });
  // One request at a time keeps the queue honest and stays inside Groq's free rate limits.
  let tail = Promise.resolve();

  function cors(req, res) {
    const origin = req.headers.origin;
    if (origin && cfg.origins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    return !origin || cfg.origins.includes(origin);
  }

  function json(res, code, body) {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(body));
  }

  return async function route(req, res, url) {
    const isApi = url.pathname.startsWith('/api/');
    const media = url.pathname.match(/^\/web-media\/([0-9a-f]{32})\.(m4a|jpg)$/);
    if (!isApi && !media) return false;
    const okOrigin = cors(req, res);

    if (media) {
      const data = web.getMedia(media[1], media[2]);
      if (!data) res.writeHead(404).end('not found');
      else res.writeHead(200, { 'Content-Type': media[2] === 'jpg' ? 'image/jpeg' : 'audio/mp4', 'Cache-Control': 'private, max-age=3600' }).end(data);
      return true;
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(okOrigin ? 204 : 403, { 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' }).end();
      return true;
    }
    if (!okOrigin) {
      json(res, 403, { error: 'origin not allowed' });
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/status') {
      json(res, 200, web.status());
    } else if (req.method === 'POST' && url.pathname === '/api/chat') {
      let body;
      try {
        body = JSON.parse((await readBody(req, MAX_BODY)).toString('utf8'));
      } catch {
        return json(res, 400, { error: 'bad request' }), true;
      }
      const visitor = String(body.visitor || '');
      if (!VISITOR.test(visitor)) return json(res, 400, { error: 'bad visitor id' }), true;

      let msg;
      let audio;
      if (typeof body.text === 'string' && body.text.trim()) {
        const text = body.text.trim();
        if (text.length > MAX_TEXT) return json(res, 400, { error: `keep it under ${MAX_TEXT} characters` }), true;
        msg = { kind: 'text', text };
      } else if (typeof body.audio === 'string') {
        const mime = String(body.mime || '').split(';')[0];
        if (!AUDIO_TYPES.includes(mime)) return json(res, 400, { error: 'unsupported audio' }), true;
        const data = Buffer.from(body.audio, 'base64');
        if (!data.length || data.length > MAX_AUDIO_BYTES) return json(res, 400, { error: 'audio too long' }), true;
        audio = { data, mimeType: mime };
        msg = { kind: 'audio' };
      } else return json(res, 400, { error: 'send text or audio' }), true;

      const admit = web.admit(visitor);
      if (!admit.ok) return json(res, 429, { error: admit.reason }), true;
      const job = web.start(visitor, audio);
      const from = `web:${visitor}`;
      // The reply follows the language of the message, so no language question for web visitors.
      store.person(from).language ??= /[ऀ-ॿ]/.test(msg.text || '') ? 'hi' : 'en';
      log.log?.(`<- web ${msg.kind} from ${visitor.slice(0, 6)}, job ${job}`);
      const work = (tail = tail.then(() =>
        handle({ ...msg, id: job, from, mediaId: job, timestamp: Date.now() })
          .then(() => web.finish(job))
          .catch((err) => {
            log.error?.(`web job ${job}: ${err.message}`);
            web.finish(job, err);
          })));
      track?.(work);
      json(res, 200, { job });
    } else if (req.method === 'GET' && url.pathname.startsWith('/api/chat/')) {
      const view = web.view(url.pathname.slice('/api/chat/'.length), url.searchParams.get('visitor') || '');
      if (!view) json(res, 404, { error: 'not found' });
      else json(res, 200, view);
    } else {
      json(res, 404, { error: 'not found' });
    }
    return true;
  };
}
