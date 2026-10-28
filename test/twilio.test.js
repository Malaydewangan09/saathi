import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createTwilioTransport, verifyTwilioSignature } from '../src/twilio.js';

const authToken = 'tok';
const url = 'https://example.trycloudflare.com/twilio';
const sign = (params) =>
  createHmac('sha1', authToken).update(url + Object.keys(params).sort().map((k) => k + params[k]).join('')).digest('base64');

test('accepts a request signed by Twilio, rejects anything else', () => {
  const params = { Body: 'hi', From: 'whatsapp:+911', MessageSid: 'SM1' };
  assert.equal(verifyTwilioSignature({ url, params, header: sign(params), authToken }), true);
  assert.equal(verifyTwilioSignature({ url, params: { ...params, Body: 'pay' }, header: sign(params), authToken }), false);
  assert.equal(verifyTwilioSignature({ url: `${url}x`, params, header: sign(params), authToken }), false);
  assert.equal(verifyTwilioSignature({ url, params, header: undefined, authToken }), false);
});

function transport() {
  const sent = [];
  const fetchImpl = async (u, init) => {
    sent.push({ url: u, body: Object.fromEntries(new URLSearchParams(init.body)) });
    return { ok: true, json: async () => ({ sid: 'SM' }) };
  };
  return { t: createTwilioTransport({ accountSid: 'AC1', authToken, from: 'whatsapp:+14155238886', publicUrl: 'https://pub', fetchImpl }), sent };
}

test('parses text and voice notes, normalizing the number', () => {
  const { t } = transport();
  assert.deepEqual(
    (({ kind, from, text }) => ({ kind, from, text }))(t.parseMessage({ MessageSid: 'a', From: 'whatsapp:+919800000001', Body: ' ट्रेन देखो ', NumMedia: '0' })),
    { kind: 'text', from: '919800000001', text: 'ट्रेन देखो' },
  );
  const voice = t.parseMessage({ MessageSid: 'b', From: 'whatsapp:+911', NumMedia: '1', MediaContentType0: 'audio/ogg', MediaUrl0: 'https://api.twilio.com/m/1' });
  assert.equal(voice.kind, 'audio');
  assert.equal(voice.mediaId, 'https://api.twilio.com/m/1');
});

test('buttons become numbered options, and a number reply maps back to the button', async () => {
  const { t, sent } = transport();
  await t.sendButtons('911', 'Approve?', [{ id: 'approve:x', title: 'Approve' }, { id: 'decline:x', title: 'Decline' }]);
  assert.match(sent[0].body.Body, /1\. Approve\n2\. Decline/);
  assert.equal(sent[0].body.To, 'whatsapp:+911');

  const reply = t.parseMessage({ MessageSid: 'c', From: 'whatsapp:+911', Body: '2', NumMedia: '0' });
  assert.deepEqual([reply.kind, reply.buttonId], ['button', 'decline:x']);
  // Choices are used once.
  assert.equal(t.parseMessage({ MessageSid: 'd', From: 'whatsapp:+911', Body: '1', NumMedia: '0' }).kind, 'text');
});

test('a reply matching the option title also works', async () => {
  const { t } = transport();
  await t.sendButtons('911', 'Language?', [{ id: 'lang:hi', title: 'हिंदी' }, { id: 'lang:en', title: 'English' }]);
  assert.equal(t.parseMessage({ MessageSid: 'e', From: 'whatsapp:+911', Body: 'english', NumMedia: '0' }).buttonId, 'lang:en');
});

test('voice notes are served once from a random, expiring URL', async () => {
  const { t, sent } = transport();
  await t.sendVoice('911', Buffer.from('ogg'));
  const mediaUrl = sent[0].body.MediaUrl;
  assert.match(mediaUrl, /^https:\/\/pub\/media\/[0-9a-f]{32}\.ogg$/);
  const id = mediaUrl.match(/media\/(\w+)\.ogg/)[1];
  assert.equal(t.getMedia(id).toString(), 'ogg');
  assert.equal(t.getMedia('nope'), null);
});

test('refuses to download media from other hosts', async () => {
  const { t } = transport();
  await assert.rejects(t.downloadMedia('https://evil.example/x'), /unexpected media host/);
});
