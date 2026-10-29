import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGroqAgent, parseReply, stripCitations } from '../src/groq.js';

test('citation marks are removed', () => {
  assert.equal(stripCitations('भाव ₹1,44,110 है【2†L55-L56】।'), 'भाव ₹1,44,110 है।');
});

test('parses the JSON reply even with text or citations around it', () => {
  const r = parseReply('Sure. {"status":"done","spoken":"सोना ₹14,395 प्रति ग्राम है【1†L3】।","card":"24K: ₹14,395/g\\nSource: moneycontrol"} ok');
  assert.equal(r.status, 'done');
  assert.equal(r.spoken, 'सोना ₹14,395 प्रति ग्राम है।');
  assert.match(r.card, /moneycontrol/);
  assert.deepEqual(r.images, []);
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

  const failing = createGroqAgent({ apiKey: 'k', fetchImpl: async () => ({ ok: false, status: 429, text: async () => 'rate limited' }) });
  await assert.rejects(failing.run({ message: 'x' }), /Groq 429/);
});
