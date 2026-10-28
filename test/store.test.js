import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';

const fresh = () => new Store('/dev/null/unused.json');

test('family approves a pending request exactly once', () => {
  const s = fresh();
  const id = s.createApproval({ elder: '911', summary: 'Book 22185', amount: 180 });
  assert.equal(s.resolveApproval(id, { decision: 'approve', by: '912', isFamily: true }).ok, true);
  const again = s.resolveApproval(id, { decision: 'approve', by: '912', isFamily: true });
  assert.deepEqual(again, { ok: false, reason: 'already approved' });
});

test('the elder or a stranger cannot approve their own request', () => {
  const s = fresh();
  const id = s.createApproval({ elder: '911', summary: 'x', amount: 1 });
  assert.equal(s.resolveApproval(id, { decision: 'approve', by: '911', isFamily: false }).reason, 'only family can approve');
});

test('approvals expire after 30 minutes', () => {
  const s = fresh();
  const id = s.createApproval({ elder: '911', summary: 'x', amount: 1, now: 0 });
  assert.equal(s.resolveApproval(id, { decision: 'approve', by: '912', isFamily: true, now: 31 * 60 * 1000 }).reason, 'expired');
});

test('decline is recorded', () => {
  const s = fresh();
  const id = s.createApproval({ elder: '911', summary: 'x', amount: 1 });
  assert.equal(s.resolveApproval(id, { decision: 'decline', by: '912', isFamily: true }).approval.status, 'declined');
});

test('unknown approval ids are rejected', () => {
  assert.equal(fresh().resolveApproval('nope', { decision: 'approve', by: '912', isFamily: true }).reason, 'unknown approval');
});

test('saves and loads people and approvals', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'saathi-store-'));
  try {
    const file = path.join(dir, 'store.json');
    const a = new Store(file);
    a.person('911').language = 'hi';
    await a.save();
    const b = await new Store(file).load();
    assert.equal(b.person('911').language, 'hi');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
