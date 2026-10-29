import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createWebApi } from '../src/web-api.js';
import { createWebChannel } from '../src/web.js';

const ORIGIN = 'https://malaydewangan09.github.io';
const VISITOR = 'abcdefghijklmnop1234';

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

async function start({ perVisitor = 6, perDay = 120, reply } = {}) {
  const runs = [];
  const agent = {
    run: async ({ message }) => {
      runs.push(message);
      return { reply: reply || { status: 'done', spoken: 'सोना ₹14,395 प्रति ग्राम है।', card: '24K ₹14,395/g', confirm_summary: '', amount_inr: 0, images: [] }, sessionId: 's' };
    },
  };
  const channel = createWebChannel({ perVisitor, perDay, convert: async () => Buffer.from('m4a') });
  const voice = { speak: async () => Buffer.from('ogg'), transcribe: async () => 'आज सोने का भाव?' };
  const route = createWebApi({ web: { origins: [ORIGIN], perVisitor, perDay }, voice, readBody, agent, channel, log: {} });
  const server = createServer(async (req, res) => {
    if (!(await route(req, res, new URL(req.url, 'http://x')))) res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  const call = (path, { method = 'GET', body, origin = ORIGIN } = {}) =>
    fetch(base + path, { method, headers: { Origin: origin, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  const until = async (job) => {
    for (let i = 0; i < 50; i++) {
      const v = await (await call(`/api/chat/${job}?visitor=${VISITOR}`)).json();
      if (v.status === 'done' || v.status === 'failed') return v;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('job did not finish');
  };
  return { call, until, runs, close: () => server.close() };
}

test('a text question gets the ack, a playable voice note and the card', async () => {
  const s = await start();
  try {
    const res = await s.call('/api/chat', { method: 'POST', body: { visitor: VISITOR, text: 'आज सोने का भाव क्या है?' } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
    const view = await s.until((await res.json()).job);
    assert.equal(view.status, 'done');
    assert.deepEqual(view.messages.map((m) => m.type), ['text', 'voice']);
    assert.match(view.messages[1].url, /^\/web-media\/[0-9a-f]{32}\.m4a$/);
    assert.equal(view.messages[1].caption, '24K ₹14,395/g');
    const audio = await s.call(view.messages[1].url);
    assert.equal(audio.headers.get('content-type'), 'audio/mp4');
  } finally {
    s.close();
  }
});

test('voice questions are transcribed, and the language question is never asked', async () => {
  const s = await start();
  try {
    const res = await s.call('/api/chat', { method: 'POST', body: { visitor: VISITOR, audio: Buffer.from('webm').toString('base64'), mime: 'audio/webm;codecs=opus' } });
    const view = await s.until((await res.json()).job);
    assert.equal(view.status, 'done');
    assert.match(s.runs[0], /आज सोने का भाव/);
    assert.ok(!view.messages.some((m) => m.type === 'choice'));
  } finally {
    s.close();
  }
});

test('other websites cannot call it', async () => {
  const s = await start();
  try {
    const res = await s.call('/api/chat', { method: 'POST', origin: 'https://evil.example', body: { visitor: VISITOR, text: 'hi' } });
    assert.equal(res.status, 403);
    assert.equal(s.runs.length, 0);
  } finally {
    s.close();
  }
});

test('bad input is refused before anything runs', async () => {
  const s = await start();
  try {
    for (const body of [{ visitor: 'short', text: 'hi' }, { visitor: VISITOR, text: 'x'.repeat(501) }, { visitor: VISITOR, audio: 'AAAA', mime: 'video/mp4' }, { visitor: VISITOR }]) {
      assert.equal((await s.call('/api/chat', { method: 'POST', body })).status, 400);
    }
    assert.equal(s.runs.length, 0);
  } finally {
    s.close();
  }
});

test('per-visitor and daily limits answer 429 with the reason', async () => {
  const s = await start({ perVisitor: 1, perDay: 5 });
  try {
    await s.until((await (await s.call('/api/chat', { method: 'POST', body: { visitor: VISITOR, text: 'one' } })).json()).job);
    const second = await s.call('/api/chat', { method: 'POST', body: { visitor: VISITOR, text: 'two' } });
    assert.equal(second.status, 429);
    assert.equal((await second.json()).error, 'visitor');
  } finally {
    s.close();
  }
});

test('a visitor cannot read someone else\'s answer', async () => {
  const s = await start();
  try {
    const { job } = await (await s.call('/api/chat', { method: 'POST', body: { visitor: VISITOR, text: 'hi' } })).json();
    const res = await s.call(`/api/chat/${job}?visitor=zzzzzzzzzzzzzzzzzzzz`);
    assert.equal(res.status, 404);
  } finally {
    s.close();
  }
});

test('status reports how many answers are left today', async () => {
  const s = await start({ perDay: 3 });
  try {
    const st = await (await s.call('/api/status')).json();
    assert.deepEqual({ online: st.online, leftToday: st.leftToday }, { online: true, leftToday: 3 });
  } finally {
    s.close();
  }
});
