import { createServer } from 'node:http';
import path from 'node:path';
import { config, require_ } from './config.js';
import { createHandler } from './handler.js';
import { Store } from './store.js';
import { runAgent } from './agent.js';
import { speak, transcribe } from './voice.js';
import * as wa from './whatsapp.js';
import { createTwilioTransport, verifyTwilioSignature } from './twilio.js';

const MAX_BODY = 1024 * 1024;

const twilio = config.transport === 'twilio';
if (twilio) require_('deepgramKey', 'twilio.accountSid', 'twilio.authToken', 'publicUrl');
else require_('deepgramKey', 'whatsapp.token', 'whatsapp.phoneNumberId', 'whatsapp.appSecret', 'whatsapp.verifyToken');
if (!config.elderNumbers.length || !config.familyNumbers.length) {
  throw new Error('set SAATHI_ELDER_NUMBERS and SAATHI_FAMILY_NUMBERS in .env');
}

const transport = twilio ? createTwilioTransport({ ...config.twilio, publicUrl: config.publicUrl }) : wa;
const store = await new Store(path.join(config.dataDir, 'store.json')).load();
const handle = createHandler({
  store,
  wa: transport,
  agent: { run: runAgent },
  voice: { speak, transcribe },
  numbers: { elderNumbers: config.elderNumbers, familyNumbers: config.familyNumbers },
});

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
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
        handle(msg).catch((err) => console.error(`handler: ${err.message}`));
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
      handle(msg).catch((err) => console.error(`handler: ${err.message}`));
    } else if (twilio && req.method === 'GET' && /^\/media\/[0-9a-f]{32}\.ogg$/.test(url.pathname)) {
      const data = transport.getMedia(url.pathname.slice(7, -4));
      if (data) res.writeHead(200, { 'Content-Type': 'audio/ogg' }).end(data);
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
    console.log('shutting down');
    server.close();
    await store.save();
    process.exit(0);
  });
}
