import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler, yesOrNo } from '../src/handler.js';
import { Store } from '../src/store.js';

const ME = '911';

function setup(agentReplies = [], { failAgent = false, failText = false, clock, collage } = {}) {
  const sent = [];
  const agentCalls = [];
  const store = new Store('/dev/null/x');
  store.save = async () => {};
  const wa = {
    sendText: async (to, text) => {
      if (failText) throw new Error('Twilio 429: daily limit');
      sent.push({ to, type: 'text', text });
    },
    sendButtons: async (to, text, buttons) => sent.push({ to, type: 'buttons', text, buttons: buttons.map((b) => b.id) }),
    sendVoice: async (to, _ogg, caption) => sent.push({ to, type: 'voice', caption }),
    sendImage: async (to, _jpg, caption) => sent.push({ to, type: 'image', caption }),
    downloadMedia: async () => ({ data: Buffer.from('ogg'), mimeType: 'audio/ogg' }),
  };
  let transcript = 'कल पुणे की ट्रेन देखो';
  const voices = [];
  const voice = { speak: async (_t, v) => { voices.push(v); return Buffer.from('ogg'); }, transcribe: async () => transcript };
  const agent = {
    run: async (args) => {
      agentCalls.push(args);
      if (failAgent) throw new Error('timeout');
      const reply = agentReplies.shift() || { status: 'done', spoken: 'ठीक है', card: '', confirm_summary: '', amount_inr: 0 };
      return { reply, sessionId: 'sess-1' };
    },
  };
  const log = { error: () => {}, warn: () => {} };
  const handle = createHandler({ store, wa, agent, voice, numbers: [ME], log, ...(clock ? { clock } : {}), ...(collage ? { collage } : {}) });
  let n = 0;
  const msg = (extra, from = ME) => ({ id: `m${++n}`, from, timestamp: Date.now(), ...extra });
  return { handle, sent, agentCalls, store, msg, voices, setTranscript: (t) => (transcript = t) };
}

const booking = { status: 'needs_confirmation', spoken: 'क्या मैं बुक करूँ?', card: '12409 SL ₹640', confirm_summary: 'गोंडवाना एक्सप्रेस, स्लीपर, ₹640, वेटिंग 57', amount_inr: 640 };

test('first voice note asks for the language, then answers the original request', async () => {
  const { handle, sent, agentCalls, msg } = setup();
  await handle(msg({ kind: 'audio', mediaId: 'x' }));
  assert.deepEqual(sent.at(-1).buttons, ['lang:hi', 'lang:en']);
  assert.equal(agentCalls.length, 0);

  await handle(msg({ kind: 'button', buttonId: 'lang:hi', text: 'हिंदी' }));
  assert.equal(agentCalls.length, 1);
  assert.match(agentCalls[0].message, /Reply language: Hindi/);
  assert.match(agentCalls[0].message, /पुणे/);
  assert.ok(sent.some((s) => s.type === 'voice'));
});

test('the agent session is reused across turns', async () => {
  const { handle, agentCalls, store, msg } = setup();
  store.person(ME).language = 'hi';
  await handle(msg({ kind: 'text', text: 'ट्रेन देखो' }));
  await handle(msg({ kind: 'text', text: 'राजनांदगाँव से दिल्ली' }));
  assert.equal(agentCalls[0].sessionId, null);
  assert.equal(agentCalls[1].sessionId, 'sess-1');
});

test('after 30 quiet minutes the conversation starts fresh, quick follow-ups keep memory', async () => {
  let now = 0;
  const { handle, agentCalls, store, msg } = setup([], { clock: () => now });
  store.person(ME).language = 'hi';
  await handle(msg({ kind: 'text', text: 'ट्रेन देखो' }));
  now = 10 * 60 * 1000;
  await handle(msg({ kind: 'text', text: 'हाँ, यही वाली' }));
  now += 31 * 60 * 1000;
  await handle(msg({ kind: 'text', text: 'दीवाली कब है?' }));
  assert.deepEqual(agentCalls.map((c) => c.sessionId), [null, 'sess-1', null]);
});

test('anything costing money asks the same person, and mentions nobody else', async () => {
  const { handle, sent, store, msg } = setup([booking]);
  store.person(ME).language = 'hi';
  await handle(msg({ kind: 'text', text: 'यही बुक कर दो' }));
  const ask = sent.find((s) => s.type === 'buttons');
  assert.equal(ask.to, ME);
  assert.match(ask.text, /₹640/);
  assert.match(ask.text, /क्या मैं यह करूँ/);
  assert.ok(!sent.some((s) => /घरवाल|परिवार|family/i.test(s.text || '')));
});

test('tapping yes continues with exactly that action, once', async () => {
  const { handle, sent, agentCalls, store, msg } = setup([booking]);
  store.person(ME).language = 'hi';
  await handle(msg({ kind: 'text', text: 'यही बुक कर दो' }));
  const yesId = sent.find((s) => s.type === 'buttons').buttons[0];
  await handle(msg({ kind: 'button', buttonId: yesId, text: 'हाँ' }));
  assert.match(agentCalls.at(-1).message, /USER CONFIRMED: गोंडवाना एक्सप्रेस/);
  await handle(msg({ kind: 'button', buttonId: yesId, text: 'हाँ' }));
  assert.equal(agentCalls.length, 2);
});

test('a spoken "हाँ, बुक कर दो" confirms, a spoken "नहीं रहने दो" cancels', async () => {
  for (const [said, expected] of [['हाँ, बुक कर दो।', /USER CONFIRMED/], ['नहीं, रहने दो', /USER SAID NO/]]) {
    const { handle, agentCalls, store, msg, setTranscript } = setup([booking]);
    store.person(ME).language = 'hi';
    await handle(msg({ kind: 'text', text: 'यही बुक कर दो' }));
    setTranscript(said);
    await handle(msg({ kind: 'audio', mediaId: 'v' }));
    assert.match(agentCalls.at(-1).message, expected);
  }
});

test('"yes, but the other one" is a new request, not a confirmation', async () => {
  const { handle, agentCalls, store, msg } = setup([booking]);
  store.person(ME).language = 'hi';
  await handle(msg({ kind: 'text', text: 'यही बुक कर दो' }));
  await handle(msg({ kind: 'text', text: 'हाँ लेकिन दूसरी वाली' }));
  assert.ok(!/USER CONFIRMED/.test(agentCalls.at(-1).message));
  assert.match(agentCalls.at(-1).message, /दूसरी वाली/);
});

test('without an open question, "हाँ" is just a message to the agent', async () => {
  const { handle, agentCalls, store, msg } = setup();
  store.person(ME).language = 'hi';
  await handle(msg({ kind: 'text', text: 'हाँ' }));
  assert.ok(!/USER CONFIRMED/.test(agentCalls[0].message));
});

test('unknown numbers and duplicate deliveries are ignored', async () => {
  const { handle, sent, agentCalls, store, msg } = setup();
  await handle(msg({ kind: 'text', text: 'hi' }, '999'));
  assert.equal(sent.length, 0);
  store.person(ME).language = 'hi';
  const m = msg({ kind: 'text', text: 'ट्रेन देखो' });
  await handle(m);
  await handle(m);
  assert.equal(agentCalls.length, 1);
});

test('the card is sent as the voice note caption, one message per reply', async () => {
  const { handle, sent, store, msg } = setup([{ status: 'done', spoken: 'मिल गई', card: '12409 SL ₹640', confirm_summary: '', amount_inr: 0 }]);
  store.person(ME).language = 'hi';
  await handle(msg({ kind: 'text', text: 'ट्रेन देखो' }));
  assert.deepEqual(sent.map((s) => s.type), ['text', 'voice']);
  assert.equal(sent[1].caption, '12409 SL ₹640');
});

test('options with photos go out as one picture with the card as caption', async () => {
  const reply = { status: 'done', spoken: 'ये झूमर मिले', card: '1. Homesake ₹1,549\n2. GA ₹1,810', confirm_summary: '', amount_inr: 0, images: ['https://a/1.jpg', 'https://a/2.jpg'] };
  const { handle, sent, store, msg } = setup([reply], { collage: async (urls) => Buffer.from(`grid of ${urls.length}`) });
  store.person(ME).language = 'hi';
  await handle(msg({ kind: 'text', text: 'झूमर दिखाओ' }));
  assert.deepEqual(sent.map((s) => s.type), ['text', 'voice', 'image']);
  assert.equal(sent[1].caption, '');
  assert.match(sent[2].caption, /Homesake/);
});

test('if the picture cannot be made, the card still goes with the voice note', async () => {
  const reply = { status: 'done', spoken: 'ये झूमर मिले', card: '1. Homesake ₹1,549', confirm_summary: '', amount_inr: 0, images: ['https://a/1.jpg'] };
  const { handle, sent, store, msg } = setup([reply], { collage: async () => { throw new Error('no images could be fetched'); } });
  store.person(ME).language = 'hi';
  await handle(msg({ kind: 'text', text: 'झूमर दिखाओ' }));
  assert.deepEqual(sent.map((s) => s.type), ['text', 'voice']);
  assert.match(sent[1].caption, /Homesake/);
});

test('an English reply is spoken in the English voice, a Hindi one in the Hindi voice', async () => {
  const en = { status: 'done', spoken: 'Here are four pressure cookers under 2,000 rupees.', card: '', confirm_summary: '', amount_inr: 0, images: [] };
  const hi = { status: 'done', spoken: 'ये चार प्रेशर कुकर मिले।', card: '', confirm_summary: '', amount_inr: 0, images: [] };
  const { handle, store, msg, voices } = setup([en, hi]);
  store.person(ME).language = 'hi';
  await handle(msg({ kind: 'text', text: 'Find me a pressure cooker' }));
  await handle(msg({ kind: 'text', text: 'प्रेशर कुकर दिखाओ' }));
  assert.deepEqual(voices, ['Rishi', 'Lekha']);
});

test('a failed ack does not stop the task', async () => {
  const { handle, sent, agentCalls, store, msg } = setup([], { failText: true });
  store.person(ME).language = 'hi';
  await handle(msg({ kind: 'text', text: 'ट्रेन देखो' }));
  assert.equal(agentCalls.length, 1);
  assert.equal(sent.at(-1).type, 'voice');
});

test('agent failure still gives a spoken reply', async () => {
  const { handle, sent, store, msg } = setup([], { failAgent: true });
  store.person(ME).language = 'hi';
  await handle(msg({ kind: 'text', text: 'ट्रेन देखो' }));
  assert.equal(sent.at(-1).type, 'voice');
});

test('yesOrNo reads short answers and refuses ambiguous ones', () => {
  assert.equal(yesOrNo('हाँ'), 'yes');
  assert.equal(yesOrNo('हां जी, कर दीजिए।'), 'yes');
  assert.equal(yesOrNo('ok'), 'yes');
  assert.equal(yesOrNo('नहीं'), 'no');
  assert.equal(yesOrNo('हाँ... नहीं, रहने दो'), 'no');
  assert.equal(yesOrNo('no'), 'no');
  assert.equal(yesOrNo('हाँ लेकिन दूसरी वाली'), null);
  assert.equal(yesOrNo('पहले मुझे बताओ कि सबसे सस्ती ट्रेन कौन सी है और कितने बजे चलती है'), null);
  assert.equal(yesOrNo('book karna hai kya'), null);
});
