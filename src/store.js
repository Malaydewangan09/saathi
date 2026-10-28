import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const CONFIRM_TTL_MS = 30 * 60 * 1000;

// Small JSON file store: per-person language, agent session and pending confirmations.
export class Store {
  constructor(file) {
    this.file = file;
    this.data = { people: {}, confirmations: {} };
    this.writing = Promise.resolve();
  }

  async load() {
    try {
      this.data = { people: {}, confirmations: {}, ...JSON.parse(await readFile(this.file, 'utf8')) };
      delete this.data.approvals;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    return this;
  }

  // Writes are serialized and atomic (write temp file, then rename).
  save() {
    this.writing = this.writing.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
      await rename(tmp, this.file);
    });
    return this.writing;
  }

  person(number) {
    return (this.data.people[number] ??= { language: null, sessionId: null, queued: null });
  }

  createConfirmation({ owner, summary, amount, now = Date.now() }) {
    const id = randomUUID().slice(0, 8);
    this.data.confirmations[id] = { owner, summary, amount, createdAt: now, status: 'pending' };
    return id;
  }

  // The newest open question for this person, if any.
  pendingConfirmation(owner, now = Date.now()) {
    const open = Object.entries(this.data.confirmations)
      .filter(([, c]) => c.owner === owner && c.status === 'pending' && now - c.createdAt <= CONFIRM_TTL_MS)
      .sort(([, a], [, b]) => b.createdAt - a.createdAt);
    return open[0]?.[0] || null;
  }

  // Only the person it was asked of, only once, only within the time limit.
  resolveConfirmation(id, { decision, by, now = Date.now() }) {
    const c = this.data.confirmations[id];
    if (!c || c.owner !== by) return { ok: false, reason: 'unknown confirmation' };
    if (c.status !== 'pending') return { ok: false, reason: `already ${c.status}` };
    if (now - c.createdAt > CONFIRM_TTL_MS) {
      c.status = 'expired';
      return { ok: false, reason: 'expired' };
    }
    c.status = decision === 'yes' ? 'confirmed' : 'cancelled';
    c.resolvedAt = now;
    return { ok: true, confirmation: c };
  }
}
