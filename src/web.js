import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const MEDIA_TTL_MS = 60 * 60 * 1000;
const JOB_TTL_MS = 2 * 60 * 60 * 1000;

export const VISITOR = /^[a-z0-9]{16,40}$/;
export const MAX_TEXT = 500;
export const MAX_AUDIO_BYTES = 900 * 1024;

// The public "Try it live" chat: same Saathi, replies collected per request instead of sent to WhatsApp.
export function createWebChannel({ perVisitor = 6, perDay = 120, now = Date.now, convert = toM4a } = {}) {
  const jobs = new Map();
  const current = new Map();
  const media = new Map();
  const uploads = new Map();
  let usage = { day: dayOf(now()), total: 0, visitors: new Map() };

  function dayOf(t) {
    return new Date(t).toISOString().slice(0, 10);
  }

  function sweep() {
    const t = now();
    if (dayOf(t) !== usage.day) usage = { day: dayOf(t), total: 0, visitors: new Map() };
    for (const [id, j] of jobs) if (t - j.createdAt > JOB_TTL_MS) jobs.delete(id);
    for (const [id, m] of media) if (m.expires < t) media.delete(id);
  }

  function jobFor(to) {
    return jobs.get(current.get(to));
  }

  function push(to, item) {
    const job = jobFor(to);
    if (!job) return;
    if (job.status === 'queued') job.status = 'working';
    job.messages.push(item);
  }

  function keep(data, ext) {
    const id = randomBytes(16).toString('hex');
    media.set(id, { data, ext, expires: now() + MEDIA_TTL_MS });
    return `/web-media/${id}.${ext}`;
  }

  return {
    // Checks the daily limits and that this visitor has nothing in flight.
    admit(visitor) {
      sweep();
      const busy = jobFor(`web:${visitor}`);
      if (busy && busy.status !== 'done') return { ok: false, reason: 'busy' };
      if (usage.total >= perDay) return { ok: false, reason: 'day' };
      if ((usage.visitors.get(visitor) || 0) >= perVisitor) return { ok: false, reason: 'visitor' };
      return { ok: true };
    },

    start(visitor, audio) {
      const id = randomBytes(12).toString('hex');
      usage.total += 1;
      usage.visitors.set(visitor, (usage.visitors.get(visitor) || 0) + 1);
      jobs.set(id, { id, visitor, status: 'queued', messages: [], createdAt: now() });
      current.set(`web:${visitor}`, id);
      if (audio) uploads.set(id, audio);
      return id;
    },

    finish(id, error) {
      const job = jobs.get(id);
      if (job) job.status = error ? 'failed' : 'done';
      uploads.delete(id);
    },

    view(id, visitor) {
      const job = jobs.get(id);
      if (!job || job.visitor !== visitor) return null;
      const ahead = [...jobs.values()].filter((j) => j.status === 'queued' && j.createdAt < job.createdAt).length;
      return { status: job.status, position: job.status === 'queued' ? ahead + 1 : 0, messages: job.messages };
    },

    status() {
      sweep();
      const waiting = [...jobs.values()].filter((j) => j.status === 'queued' || j.status === 'working').length;
      return { online: true, waiting, leftToday: Math.max(0, perDay - usage.total) };
    },

    getMedia(id, ext) {
      const m = media.get(id);
      return m && m.ext === ext && m.expires >= now() ? m.data : null;
    },

    // Transport interface used by the handler.
    transport: {
      sendText: async (to, text) => push(to, { type: 'text', text }),
      sendButtons: async (to, text, buttons) => push(to, { type: 'choice', text, options: buttons.map((b) => b.title) }),
      sendVoice: async (to, ogg, caption = '') => push(to, { type: 'voice', url: keep(await convert(ogg), 'm4a'), caption }),
      sendImage: async (to, jpg, caption = '') => push(to, { type: 'image', url: keep(jpg, 'jpg'), caption }),
      downloadMedia: async (id) => {
        const audio = uploads.get(id);
        if (!audio) throw new Error('no audio for this request');
        return audio;
      },
    },
  };
}

// WhatsApp voice notes are Ogg Opus, which Safari cannot play. Browsers get AAC in an M4A.
async function toM4a(ogg) {
  const dir = await mkdtemp(path.join(tmpdir(), 'saathi-web-'));
  try {
    const src = path.join(dir, 'in.ogg');
    const out = path.join(dir, 'out.m4a');
    await writeFile(src, ogg);
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', out]);
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
