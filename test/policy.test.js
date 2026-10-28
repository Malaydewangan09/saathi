import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReply } from '../src/policy.js';

const base = { status: 'done', spoken: 'ठीक है', card: '', confirm_summary: '', amount_inr: 0 };

test('keeps a valid reply as is', () => {
  assert.deepEqual(normalizeReply(base), base);
});

test('unknown status falls back to needs_input', () => {
  assert.equal(normalizeReply({ ...base, status: 'pay_now' }).status, 'needs_input');
});

test('a confirmation without a summary is downgraded to a question', () => {
  assert.equal(normalizeReply({ ...base, status: 'needs_confirmation' }).status, 'needs_input');
});

test('a confirmation with a summary is kept', () => {
  const r = normalizeReply({ ...base, status: 'needs_confirmation', confirm_summary: 'गोंडवाना एक्सप्रेस, स्लीपर, ₹640' });
  assert.equal(r.status, 'needs_confirmation');
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
