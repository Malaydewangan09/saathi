import { createServer } from 'node:http';
import path from 'node:path';
import { config, require_ } from './config.js';
import { createHandler } from './handler.js';
import { Store } from './store.js';
import { runAgent } from './agent.js';
import { speak, transcribe } from './voice.js';
import * as wa from './whatsapp.js';
import { createTwilioTransport, verifyTwilioSignature } from './twilio.js';
import { withLocalPlayback } from './local.js';
import { makeCollage } from './collage.js';
import { createWebApi } from './web-api.js';

const MAX_BODY = 1024 * 1024;
const inflight = new Set();

// Tracks every message being handled, so shutdown can wait for replies in progress.
function track(promise) {
  inflight.add(promise);
  promise.finally(() => inflight.delete(promise));
}

const twilio = config.transport === 'twilio';
if (twilio) require_('deepgramKey', 'twilio.accountSid', 'twilio.authToken', 'publicUrl');
else require_('deepgramKey', 'whatsapp.token', 'whatsapp.phoneNumberId', 'whatsapp.appSecret', 'whatsapp.verifyToken');
if (!config.numbers.length) throw new Error('set SAATHI_NUMBERS in .env');

const channel = twilio ? createTwilioTransport({ ...config.twilio, publicUrl: config.publicUrl }) : wa;
// For testing on this Mac: replies the channel refuses are played and printed here.
const transport = config.playLocally ? withLocalPlayback(channel) : channel;
const store = await new Store(path.join(config.dataDir, 'store.json')).load();
const handle = createHandler({
  store,
  wa: transport,
  agent: { run: runAgent },
  voice: { speak, transcribe },
  numbers: config.numbers,
  collage: makeCollage,
});

function readBody(req, max = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        reject(new Error('body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

if (config.web.enabled) require_('web.groqKey');
const webApi = config.web.enabled ? createWebApi({ web: config.web, voice: { speak, transcribe }, readBody, track }) : null;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (webApi && (await webApi(req, res, url))) return;
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200).end('ok');
    } else if (req.method === 'GET' && url.pathname === '/webhook') {
      const challenge = wa.verifyChallenge(url.searchParams, config.whatsapp.verifyToken);
      console.log(`webhook verification ${challenge ? 'accepted' : 'rejected'}`);
      res.writeHead(challenge ? 200 : 403).end(challenge || 'forbidden');
    } else if (req.method === 'POST' && url.pathname === '/webhook') {
      const raw = await readBody(req);
      if (!wa.verifySignature(raw, req.headers['x-hub-signature-256'], config.whatsapp.appSecret)) {
        console.warn(`rejected webhook: bad or missing signature (${raw.length} bytes)`);
        res.writeHead(401).end('bad signature');
        return;
      }
      // Answer Meta right away. The work takes longer than its webhook timeout.
      res.writeHead(200).end('ok');
      console.log(`webhook: ${raw.length} bytes, signature ok`);
      const payload = JSON.parse(raw);
      for (const s of wa.parseStatuses(payload)) {
        console.log(`   status ${s.status} for ...${s.to.slice(-4)}${s.error ? `: ${s.error}` : ''}`);
      }
      for (const msg of wa.parseMessages(payload)) {
        console.log(`<- ${msg.kind} from ...${msg.from.slice(-4)}`);
        track(handle(msg).catch((err) => console.error(`handler: ${err.message}`)));
      }
    } else if (twilio && req.method === 'POST' && url.pathname === '/twilio') {
      const params = Object.fromEntries(new URLSearchParams((await readBody(req)).toString('utf8')));
      // Twilio signs the public URL it called, not the local one.
      if (!verifyTwilioSignature({ url: `${config.publicUrl}/twilio`, params, header: req.headers['x-twilio-signature'], authToken: config.twilio.authToken })) {
        console.warn('rejected twilio webhook: bad or missing signature');
        res.writeHead(401).end('bad signature');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/xml' }).end('<Response/>');
      const msg = transport.parseMessage(params);
      console.log(`<- ${msg.kind} from ...${msg.from.slice(-4)}`);
      track(handle(msg).catch((err) => console.error(`handler: ${err.message}`)));
    } else if (twilio && req.method === 'GET' && /^\/media\/[0-9a-f]{32}\.(ogg|jpg)$/.test(url.pathname)) {
      const [, id, ext] = url.pathname.match(/^\/media\/(\w+)\.(\w+)$/);
      const data = transport.getMedia(id, ext);
      if (data) res.writeHead(200, { 'Content-Type': ext === 'jpg' ? 'image/jpeg' : 'audio/ogg' }).end(data);
      else res.writeHead(404).end('not found');
    } else {
      res.writeHead(404).end('not found');
    }
  } catch (err) {
    console.error(`request: ${err.message}`);
    if (!res.headersSent) res.writeHead(400).end('bad request');
  }
});

server.listen(config.port, () => console.log(`Saathi (${config.transport}) listening on http://localhost:${config.port}/${twilio ? 'twilio' : 'webhook'}`));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, async () => {
    console.log(`shutting down, waiting for ${inflight.size} reply(s) in progress`);
    server.close();
    const limit = new Promise((r) => setTimeout(r, config.agentTimeoutMs + 30_000).unref());
    await Promise.race([Promise.allSettled([...inflight]), limit]);
    await store.save();
    process.exit(0);
  });
}
