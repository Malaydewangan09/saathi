import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { chromium } from 'playwright';
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const TILE = 480;

// Image URLs come from web pages via the model, so only public https hosts are fetched (no local network).
export function isPrivateAddress(ip) {
  if (ip === '::1' || ip.startsWith('fe80:') || ip.startsWith('fc') || ip.startsWith('fd')) return true;
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  const [a, b] = v4.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
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

async function fetchImage(raw) {
  const url = await checkImageUrl(raw);
  // No redirects: a redirect could point at the local network after the check above.
  const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { 'User-Agent': 'Mozilla/5.0 Saathi' } });
  if (!res.ok) throw new Error(`image ${res.status}`);
  if (!(res.headers.get('content-type') || '').startsWith('image/')) throw new Error('not an image');
  const data = Buffer.from(await res.arrayBuffer());
  if (data.length > MAX_IMAGE_BYTES) throw new Error('image too large');
  return data;
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
