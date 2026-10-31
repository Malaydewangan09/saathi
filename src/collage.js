import { lookup as lookupCb } from 'node:dns';
import { lookup } from 'node:dns/promises';
import https from 'node:https';
import { isIP } from 'node:net';
import { chromium } from 'playwright';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const TILE = 480;

// Image URLs come from web pages via the model, so only public https hosts are fetched (no local network).
export function isPrivateAddress(ip) {
  const v6 = ip.toLowerCase();
  if (v6 === '::' || v6 === '::1' || /^(fe[89ab]|f[cd]|ff)/.test(v6)) return true;
  const v4 = v6.startsWith('::ffff:') ? v6.slice(7) : v6;
  if (isIP(v4) !== 4) return false;
  const [a, b] = v4.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19));
}

// The same check at connect time, on the address actually dialled, so DNS cannot change between check and fetch.
export function guardedLookup(hostname, options, cb, resolve = lookupCb) {
  resolve(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err);
    if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) return cb(new Error('host not allowed'));
    if (options.all) return cb(null, addrs);
    cb(null, addrs[0].address, addrs[0].family);
  });
}

export async function checkImageUrl(raw, resolve = lookup) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('not a URL');
  }
  if (url.protocol !== 'https:') throw new Error('only https images');
  if (isIP(url.hostname) || url.hostname === 'localhost' || url.hostname.endsWith('.local')) throw new Error('host not allowed');
  const addrs = await resolve(url.hostname, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) throw new Error('host not allowed');
  return url;
}

// No redirects (https.get does not follow them), and the size limit applies while reading, not after.
async function fetchImage(raw) {
  const url = await checkImageUrl(raw);
  return new Promise((resolve, reject) => {
    const req = https.get(url, { lookup: guardedLookup, signal: AbortSignal.timeout(10_000), headers: { 'User-Agent': 'Mozilla/5.0 Saathi' } }, (res) => {
      const fail = (msg) => {
        res.resume();
        reject(new Error(msg));
      };
      if (res.statusCode < 200 || res.statusCode > 299) return fail(`image ${res.statusCode}`);
      if (!(res.headers['content-type'] || '').startsWith('image/')) return fail('not an image');
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_IMAGE_BYTES) req.destroy(new Error('image too large'));
        else chunks.push(c);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

// Builds one numbered picture (1 to 4 tiles) so a single WhatsApp message shows every option.
// Rendered with the bundled Chromium: the images are already fetched and checked, and go in as data URIs.
export async function makeCollage(urls) {
  const images = (await Promise.allSettled(urls.slice(0, 4).map(fetchImage)))
    .map((r, i) => (r.status === 'fulfilled' ? { data: r.value, n: i + 1 } : null))
    .filter(Boolean);
  if (!images.length) throw new Error('no images could be fetched');

  const cols = images.length === 1 ? 1 : 2;
  const tiles = images
    .map((img) => `<figure><img src="data:image/*;base64,${img.data.toString('base64')}"><b>${img.n}</b></figure>`)
    .join('');
  const html = `<!doctype html><meta charset="utf-8"><style>
    *{margin:0;box-sizing:border-box} body{background:#fff;width:${cols * TILE}px}
    main{display:grid;grid-template-columns:repeat(${cols},${TILE}px)}
    figure{position:relative;width:${TILE}px;height:${TILE}px;display:grid;place-items:center;border:1px solid #eee}
    img{max-width:92%;max-height:92%;object-fit:contain}
    b{position:absolute;top:14px;left:14px;font:700 40px/1 -apple-system,Helvetica,sans-serif;color:#fff;
      background:#111;border-radius:999px;width:60px;height:60px;display:grid;place-items:center}
  </style><main>${tiles}</main>`;

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: cols * TILE, height: Math.ceil(images.length / cols) * TILE } });
    // Block every network request: the page only shows the data URIs above.
    await page.route('**/*', (route) => (route.request().url().startsWith('data:') ? route.continue() : route.abort()));
    await page.setContent(html, { waitUntil: 'load' });
    return await page.locator('main').screenshot({ type: 'jpeg', quality: 85 });
  } finally {
    await browser.close();
  }
}
