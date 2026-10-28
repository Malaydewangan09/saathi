import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { parseMessages, verifyChallenge, verifySignature } from '../src/whatsapp.js';

const secret = 'app-secret';
const sign = (body) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

test('accepts a body signed by Meta', () => {
  const body = Buffer.from('{"entry":[]}');
  assert.equal(verifySignature(body, sign(body), secret), true);
});

test('rejects tampered, unsigned or wrongly signed bodies', () => {
  const body = Buffer.from('{"entry":[]}');
  assert.equal(verifySignature(Buffer.from('{"entry":[1]}'), sign(body), secret), false);
  assert.equal(verifySignature(body, undefined, secret), false);
  assert.equal(verifySignature(body, 'sha256=abc', secret), false);
  assert.equal(verifySignature(body, sign(body), undefined), false);
});

test('answers the verification challenge only with the right token', () => {
  const q = new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.verify_token': 'tok', 'hub.challenge': '42' });
  assert.equal(verifyChallenge(q, 'tok'), '42');
  assert.equal(verifyChallenge(q, 'other'), null);
  assert.equal(verifyChallenge(q, undefined), null);
});

const payload = (messages) => ({ entry: [{ changes: [{ value: { messages } }] }] });

test('parses voice notes, text and button taps', () => {
  const msgs = parseMessages(payload([
    { id: 'a', from: '91111', timestamp: '1700000000', type: 'audio', audio: { id: 'm1', mime_type: 'audio/ogg; codecs=opus' } },
    { id: 'b', from: '91111', timestamp: '1700000001', type: 'text', text: { body: 'ट्रेन देखो' } },
    { id: 'c', from: '91222', timestamp: '1700000002', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'approve:x', title: 'Approve' } } },
    { id: 'd', from: '91111', timestamp: '1700000003', type: 'sticker' },
  ]));
  assert.deepEqual(msgs.map((m) => m.kind), ['audio', 'text', 'button', 'unsupported']);
  assert.equal(msgs[0].mediaId, 'm1');
  assert.equal(msgs[1].text, 'ट्रेन देखो');
  assert.equal(msgs[2].buttonId, 'approve:x');
  assert.equal(msgs[0].timestamp, 1700000000000);
});

test('ignores delivery status updates and empty payloads', () => {
  assert.deepEqual(parseMessages({ entry: [{ changes: [{ value: { statuses: [{ status: 'read' }] } }] }] }), []);
  assert.deepEqual(parseMessages(null), []);
});
