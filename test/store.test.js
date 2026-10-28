import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';

const fresh = () => new Store('/dev/null/unused.json');

test('the person confirms their own request exactly once', () => {
  const s = fresh();
  const id = s.createConfirmation({ owner: '911', summary: 'Book 12409', amount: 640 });
  assert.equal(s.resolveConfirmation(id, { decision: 'yes', by: '911' }).ok, true);
  assert.deepEqual(s.resolveConfirmation(id, { decision: 'yes', by: '911' }), { ok: false, reason: 'already confirmed' });
});

test('nobody else can answer someone else\'s confirmation', () => {
  const s = fresh();
  const id = s.createConfirmation({ owner: '911', summary: 'x', amount: 1 });
  assert.equal(s.resolveConfirmation(id, { decision: 'yes', by: '999' }).reason, 'unknown confirmation');
});

test('confirmations expire after 30 minutes', () => {
  const s = fresh();
  const id = s.createConfirmation({ owner: '911', summary: 'x', amount: 1, now: 0 });
  assert.equal(s.resolveConfirmation(id, { decision: 'yes', by: '911', now: 31 * 60 * 1000 }).reason, 'expired');
  assert.equal(s.pendingConfirmation('911', 31 * 60 * 1000), null);
});

test('no is recorded as cancelled', () => {
  const s = fresh();
  const id = s.createConfirmation({ owner: '911', summary: 'x', amount: 1 });
  assert.equal(s.resolveConfirmation(id, { decision: 'no', by: '911' }).confirmation.status, 'cancelled');
});

test('pendingConfirmation returns the newest open question', () => {
  const s = fresh();
  s.createConfirmation({ owner: '911', summary: 'old', amount: 1, now: 1000 });
  const newer = s.createConfirmation({ owner: '911', summary: 'new', amount: 1, now: 2000 });
  assert.equal(s.pendingConfirmation('911', 3000), newer);
  assert.equal(s.pendingConfirmation('912', 3000), null);
});

test('saves and loads, dropping the old approvals field', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'saathi-store-'));
  try {
    const file = path.join(dir, 'store.json');
    const a = new Store(file);
    a.person('911').language = 'hi';
    a.data.approvals = { old: {} };
    await a.save();
    const b = await new Store(file).load();
    assert.equal(b.person('911').language, 'hi');
    assert.equal(b.data.approvals, undefined);
    assert.deepEqual(b.data.confirmations, {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
