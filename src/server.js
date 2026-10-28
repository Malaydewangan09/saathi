import { createServer } from 'node:http';
import path from 'node:path';
import { config, require_ } from './config.js';
import { createHandler } from './handler.js';
import { Store } from './store.js';
import { runAgent } from './agent.js';
import { speak, transcribe } from './voice.js';
import * as wa from './whatsapp.js';

const MAX_BODY = 1024 * 1024;

require_('deepgramKey', 'whatsapp.token', 'whatsapp.phoneNumberId', 'whatsapp.appSecret', 'whatsapp.verifyToken');
if (!config.elderNumbers.length || !config.familyNumbers.length) {
  throw new Error('set SAATHI_ELDER_NUMBERS and SAATHI_FAMILY_NUMBERS in .env');
}

const store = await new Store(path.join(config.dataDir, 'store.json')).load();
const handle = createHandler({
  store,
  wa,
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
      res.writeHead(challenge ? 200 : 403).end(challenge || 'forbidden');
    } else if (req.method === 'POST' && url.pathname === '/webhook') {
      const raw = await readBody(req);
      if (!wa.verifySignature(raw, req.headers['x-hub-signature-256'], config.whatsapp.appSecret)) {
        res.writeHead(401).end('bad signature');
        return;
      }
      // Answer Meta right away. The work takes longer than its webhook timeout.
      res.writeHead(200).end('ok');
      for (const msg of wa.parseMessages(JSON.parse(raw))) {
        console.log(`<- ${msg.kind} from ...${msg.from.slice(-4)}`);
        handle(msg).catch((err) => console.error(`handler: ${err.message}`));
      }
    } else {
      res.writeHead(404).end('not found');
    }
  } catch (err) {
    console.error(`request: ${err.message}`);
    if (!res.headersSent) res.writeHead(400).end('bad request');
  }
});

server.listen(config.port, () => console.log(`Saathi listening on http://localhost:${config.port}/webhook`));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, async () => {
    console.log('shutting down');
    server.close();
    await store.save();
    process.exit(0);
  });
}
