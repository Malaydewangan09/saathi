import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReply, roleOf } from '../src/policy.js';

const base = { status: 'done', spoken: 'ठीक है', card: '', approval_summary: '', amount_inr: 0, family_note: '' };

test('keeps a valid reply as is', () => {
  assert.deepEqual(normalizeReply(base), base);
});

test('unknown status falls back to needs_input', () => {
  assert.equal(normalizeReply({ ...base, status: 'pay_now' }).status, 'needs_input');
});

test('approval without a summary is downgraded to a question', () => {
  assert.equal(normalizeReply({ ...base, status: 'needs_approval' }).status, 'needs_input');
});

test('approval always carries a family note', () => {
  const r = normalizeReply({ ...base, status: 'needs_approval', approval_summary: 'Book 22185 SL, ₹180' });
  assert.equal(r.status, 'needs_approval');
  assert.equal(r.family_note, 'Book 22185 SL, ₹180');
});

test('scam warning always carries a family note', () => {
  const r = normalizeReply({ ...base, status: 'scam_warning', spoken: 'यह धोखा है' });
  assert.ok(r.family_note.length > 0);
});

test('bad amounts become 0, fractional amounts are rounded', () => {
  assert.equal(normalizeReply({ ...base, amount_inr: -5 }).amount_inr, 0);
  assert.equal(normalizeReply({ ...base, amount_inr: 'lots' }).amount_inr, 0);
  assert.equal(normalizeReply({ ...base, amount_inr: 180.4 }).amount_inr, 180);
});

test('empty spoken text gets a fallback so a voice note is always sent', () => {
  assert.ok(normalizeReply({ ...base, spoken: '   ' }).spoken.length > 0);
});

test('long text is clipped', () => {
  assert.ok(normalizeReply({ ...base, spoken: 'क'.repeat(5000) }).spoken.length <= 600);
});

test('rejects a missing reply', () => {
  assert.throws(() => normalizeReply(null), /no reply/);
});

test('roles: family wins over elder, strangers are unknown', () => {
  const cfg = { elderNumbers: ['911', '912'], familyNumbers: ['912'] };
  assert.equal(roleOf('911', cfg), 'elder');
  assert.equal(roleOf('912', cfg), 'family');
  assert.equal(roleOf('999', cfg), 'unknown');
});
