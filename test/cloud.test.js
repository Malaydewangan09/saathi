import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCloudChat, replyLanguage } from '../src/cloud.js';

const ORIGIN = 'https://malaydewangan09.github.io';
const VISITOR = 'abcdefghijklmnop1234';
const reply = (spoken, card = '') => ({ reply: { status: 'done', spoken, card, confirm_summary: '', amount_inr: 0, images: [] }, sessionId: 's' });

test('only the Saathi website is allowed', () => {
  const chat = createCloudChat({ apiKey: 'k', origins: [ORIGIN], agent: { run: async () => reply('x') } });
  assert.equal(chat.allowedOrigin(ORIGIN), true);
  assert.equal(chat.allowedOrigin('https://evil.example'), false);
  assert.equal(chat.allowedOrigin(undefined), false);
});

test('a text question gets the spoken answer, the card and its language', async () => {
  const chat = createCloudChat({ apiKey: 'k', origins: [ORIGIN], agent: { run: async () => reply('सोना ₹14,395 प्रति ग्राम है।', '24K ₹14,395/g') } });
  const [status, body] = await chat.ask({ visitor: VISITOR, text: 'आज सोने का भाव?' });
  assert.equal(status, 200);
  assert.deepEqual([body.spoken, body.card, body.lang], ['सोना ₹14,395 प्रति ग्राम है।', '24K ₹14,395/g', 'hi']);
});

test('a voice question is transcribed with Groq Whisper first', async () => {
  const asked = [];
  const fetchImpl = async (url, init) => {
    assert.match(url, /audio\/transcriptions/);
    assert.equal(init.body.get('model'), 'whisper-large-v3-turbo');
    return { ok: true, json: async () => ({ text: ' When is Diwali? ' }) };
  };
  const chat = createCloudChat({ apiKey: 'k', origins: [ORIGIN], fetchImpl, agent: { run: async ({ message }) => (asked.push(message), reply('Sunday, 8 November.')) } });
  const [status, body] = await chat.ask({ visitor: VISITOR, audio: Buffer.from('webm').toString('base64'), mime: 'audio/webm;codecs=opus' });
  assert.equal(status, 200);
  assert.deepEqual(asked, ['When is Diwali?']);
  assert.equal(body.transcript, 'When is Diwali?');
  assert.equal(body.lang, 'en');
});

test('bad input is refused before any model call', async () => {
  let calls = 0;
  const chat = createCloudChat({ apiKey: 'k', origins: [ORIGIN], agent: { run: async () => (calls++, reply('x')) } });
  for (const body of [{ visitor: 'short', text: 'hi' }, { visitor: VISITOR, text: 'x'.repeat(501) }, { visitor: VISITOR, audio: 'AAAA', mime: 'video/mp4' }, { visitor: VISITOR }]) {
    assert.equal((await chat.ask(body))[0], 400);
  }
  assert.equal(calls, 0);
});

test('each visitor and each address gets a few questions a day', async () => {
  let t = Date.parse('2026-10-29T10:00:00Z');
  const chat = createCloudChat({ apiKey: 'k', origins: [ORIGIN], perVisitor: 2, now: () => t, agent: { run: async () => reply('ok') } });
  assert.equal((await chat.ask({ visitor: VISITOR, text: 'a' }, { ip: '1.1.1.1' }))[0], 200);
  assert.equal((await chat.ask({ visitor: VISITOR, text: 'b' }, { ip: '1.1.1.1' }))[0], 200);
  assert.equal((await chat.ask({ visitor: VISITOR, text: 'c' }, { ip: '1.1.1.1' }))[0], 429);
  // A new visitor id from the same address is still limited by the address.
  assert.equal((await chat.ask({ visitor: 'zzzzzzzzzzzzzzzzzzzz', text: 'd' }, { ip: '1.1.1.1' }))[0], 429);
  t += 24 * 60 * 60 * 1000;
  assert.equal((await chat.ask({ visitor: VISITOR, text: 'e' }, { ip: '1.1.1.1' }))[0], 200);
});

test('Groq being busy or failing gives a clear status, not a crash', async () => {
  const busy = createCloudChat({ apiKey: 'k', origins: [ORIGIN], agent: { run: async () => { throw new Error('Groq is busy, every model is at its rate limit'); } } });
  assert.deepEqual(await busy.ask({ visitor: VISITOR, text: 'a' }), [503, { error: 'busy' }]);
  const broken = createCloudChat({ apiKey: 'k', origins: [ORIGIN], agent: { run: async () => { throw new Error('Groq 500: boom'); } } });
  assert.deepEqual(await broken.ask({ visitor: VISITOR, text: 'a' }), [502, { error: 'failed' }]);
});

test('reply language follows the person\'s own words, not quoted text', () => {
  assert.equal(replyLanguage('आज सोने का भाव क्या है?'), 'Hindi, in Devanagari script');
  assert.equal(replyLanguage('Is this message real? "आपका खाता बंद हो जाएगा"'), 'English');
  assert.equal(replyLanguage('यह मैसेज सच है क्या? "Your SBI account will be blocked"'), 'Hindi, in Devanagari script');
});
