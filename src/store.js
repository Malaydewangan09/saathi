import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const APPROVAL_TTL_MS = 30 * 60 * 1000;

// Small JSON file store: per-person language, agent session and pending family approvals.
export class Store {
  constructor(file) {
    this.file = file;
    this.data = { people: {}, approvals: {} };
    this.writing = Promise.resolve();
  }

  async load() {
    try {
      this.data = JSON.parse(await readFile(this.file, 'utf8'));
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

  createApproval({ elder, summary, amount, now = Date.now() }) {
    const id = randomUUID().slice(0, 8);
    this.data.approvals[id] = { elder, summary, amount, createdAt: now, status: 'pending' };
    return id;
  }

  // Only a family member, only once, only within the time limit.
  resolveApproval(id, { decision, by, isFamily, now = Date.now() }) {
    const a = this.data.approvals[id];
    if (!a) return { ok: false, reason: 'unknown approval' };
    if (!isFamily) return { ok: false, reason: 'only family can approve' };
    if (a.status !== 'pending') return { ok: false, reason: `already ${a.status}` };
    if (now - a.createdAt > APPROVAL_TTL_MS) {
      a.status = 'expired';
      return { ok: false, reason: 'expired' };
    }
    a.status = decision === 'approve' ? 'approved' : 'declined';
    a.by = by;
    a.resolvedAt = now;
    return { ok: true, approval: a };
  }
}
