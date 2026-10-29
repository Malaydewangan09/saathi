import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGroqAgent, parseReply, retryAfterMs, stripCitations, systemFor } from '../src/groq.js';

test('citation marks are removed', () => {
  assert.equal(stripCitations('भाव ₹1,44,110 है【2†L55-L56】।'), 'भाव ₹1,44,110 है।');
});

test('markdown bold and link brackets are removed', () => {
  assert.equal(stripCitations('1. **₹1,43,560 / 10 ग्राम** <https://example.com/a>'), '1. ₹1,43,560 / 10 ग्राम https://example.com/a');
});

test('parses the JSON reply even with text or citations around it', () => {
  const r = parseReply('Sure. {"status":"done","spoken":"सोना ₹14,395 प्रति ग्राम है【1†L3】।","card":"24K: ₹14,395/g\\nSource: moneycontrol"} ok');
  assert.equal(r.status, 'done');
  assert.equal(r.spoken, 'सोना ₹14,395 प्रति ग्राम है।');
  assert.match(r.card, /moneycontrol/);
  assert.deepEqual(r.images, []);
});

test('parses the SPOKEN and CARD sections', () => {
  const r = parseReply('SPOKEN: यह ठगी है। उस नंबर पर फ़ोन मत कीजिए【1†L2】।\nCARD: Scam alert\n- Do not call 9812345621\nSource: cybercrime.gov.in');
  assert.equal(r.spoken, 'यह ठगी है। उस नंबर पर फ़ोन मत कीजिए।');
  assert.match(r.card, /^Scam alert/);
  assert.match(r.card, /cybercrime\.gov\.in$/);
});

test('retries once when the model calls a tool that does not exist', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) return { ok: false, status: 400, text: async () => '{"error":{"code":"tool_use_failed"}}' };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'SPOKEN: ok\nCARD: x' } }] }) };
  };
  const { reply } = await createGroqAgent({ apiKey: 'k', fetchImpl }).run({ message: 'hi' });
  assert.equal(calls, 2);
  assert.equal(reply.spoken, 'ok');
});

test('the public demo can never ask for a money confirmation', () => {
  assert.equal(parseReply('{"status":"needs_confirmation","spoken":"Book it?","card":""}').status, 'done');
});

test('falls back to speaking plain text when the model ignores the format', () => {
  const r = parseReply('आज दिल्ली में बारिश नहीं होगी।');
  assert.equal(r.spoken, 'आज दिल्ली में बारिश नहीं होगी।');
});

test('keeps a short history per session and surfaces API errors', async () => {
  const bodies = [];
  const fetchImpl = async (_u, init) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"status":"done","spoken":"ok","card":""}' } }] }) };
  };
  const agent = createGroqAgent({ apiKey: 'k', fetchImpl });
  const first = await agent.run({ message: 'gold rate?' });
  await agent.run({ message: 'and silver?', sessionId: first.sessionId });
  assert.equal(bodies[1].messages.length, 4);
  assert.equal(bodies[1].tools[0].type, 'browser_search');

  const failing = createGroqAgent({ apiKey: 'k', fetchImpl: async () => ({ ok: false, status: 500, text: async () => 'boom' }) });
  await assert.rejects(failing.run({ message: 'x' }), /Groq 500/);
});

const ok = (content) => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) });
const limited = (msg = 'Please try again in 3.5s') => ({ ok: false, status: 429, headers: { get: () => null }, text: async () => msg });

test('a rate-limited big model hands over to the small model', async () => {
  const models = [];
  const fetchImpl = async (_u, init) => {
    const { model } = JSON.parse(init.body);
    models.push(model);
    return model.endsWith('120b') ? limited() : ok('SPOKEN: from the small model\nCARD: x');
  };
  const { reply } = await createGroqAgent({ apiKey: 'k', fetchImpl, sleep: async () => {} }).run({ message: 'hi' });
  assert.deepEqual(models, ['openai/gpt-oss-120b', 'openai/gpt-oss-20b']);
  assert.equal(reply.spoken, 'from the small model');
});

test('when every model is busy it waits as asked, then answers', async () => {
  let calls = 0;
  const waits = [];
  const fetchImpl = async () => (++calls <= 2 ? limited('try again in 7.25s') : ok('SPOKEN: ok\nCARD: x'));
  const { reply } = await createGroqAgent({ apiKey: 'k', fetchImpl, sleep: async (ms) => waits.push(ms) }).run({ message: 'hi' });
  assert.equal(reply.spoken, 'ok');
  assert.deepEqual(waits, [7750]);
});

test('gives up instead of waiting more than a minute', async () => {
  const fetchImpl = async () => limited('try again in 5m12s');
  await assert.rejects(createGroqAgent({ apiKey: 'k', fetchImpl, sleep: async () => {} }).run({ message: 'hi' }), /busy/);
});

test('reads the wait time from the header or the message', () => {
  assert.equal(retryAfterMs({ get: () => '4' }, ''), 4000);
  assert.equal(retryAfterMs({ get: () => null }, 'Please try again in 1m2.5s'), 62500);
});

test("every question carries today's date and, when given, the reply language", () => {
  const s = systemFor('English', Date.parse('2026-10-29T08:00:00Z'));
  assert.match(s, /Today is Thursday,? 29 October 2026 in India/);
  assert.match(s, /only in English/);
  assert.doesNotMatch(systemFor(undefined, 0), /only in/);
});
