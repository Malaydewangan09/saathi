import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../src/handler.js';
import { Store } from '../src/store.js';

const ELDER = '911';
const KID = '912';

function setup(agentReplies = [], { failAgent = false } = {}) {
  const sent = [];
  const agentCalls = [];
  const store = new Store('/dev/null/x');
  store.save = async () => {};
  const wa = {
    sendText: async (to, text) => sent.push({ to, type: 'text', text }),
    sendButtons: async (to, text, buttons) => sent.push({ to, type: 'buttons', text, buttons: buttons.map((b) => b.id) }),
    sendVoice: async (to) => sent.push({ to, type: 'voice' }),
    downloadMedia: async () => ({ data: Buffer.from('ogg'), mimeType: 'audio/ogg' }),
  };
  const voice = { speak: async () => Buffer.from('ogg'), transcribe: async () => 'कल पुणे की ट्रेन देखो' };
  const agent = {
    run: async (args) => {
      agentCalls.push(args);
      if (failAgent) throw new Error('timeout');
      const reply = agentReplies.shift() || { status: 'done', spoken: 'ठीक है', card: '', approval_summary: '', amount_inr: 0, family_note: '' };
      return { reply, sessionId: 'sess-1' };
    },
  };
  const log = { error: () => {}, warn: () => {} };
  const handle = createHandler({ store, wa, agent, voice, numbers: { elderNumbers: [ELDER], familyNumbers: [KID] }, log });
  let n = 0;
  const msg = (from, extra) => ({ id: `m${++n}`, from, timestamp: Date.now(), ...extra });
  return { handle, sent, agentCalls, store, msg };
}

test('first voice note asks for the language, then answers the original request', async () => {
  const { handle, sent, agentCalls, msg } = setup();
  await handle(msg(ELDER, { kind: 'audio', mediaId: 'x' }));
  assert.equal(sent.at(-1).type, 'buttons');
  assert.deepEqual(sent.at(-1).buttons, ['lang:hi', 'lang:en']);
  assert.equal(agentCalls.length, 0);

  await handle(msg(ELDER, { kind: 'button', buttonId: 'lang:hi', text: 'हिंदी' }));
  assert.equal(agentCalls.length, 1);
  assert.match(agentCalls[0].message, /Reply language: Hindi/);
  assert.match(agentCalls[0].message, /पुणे/);
  assert.ok(sent.some((s) => s.to === ELDER && s.type === 'voice'));
});

test('the agent session is reused across turns', async () => {
  const { handle, agentCalls, store, msg } = setup();
  store.person(ELDER).language = 'hi';
  await handle(msg(ELDER, { kind: 'text', text: 'ट्रेन देखो' }));
  await handle(msg(ELDER, { kind: 'text', text: 'हाँ, यही वाली' }));
  assert.equal(agentCalls[0].sessionId, null);
  assert.equal(agentCalls[1].sessionId, 'sess-1');
});

test('money needs family approval, and approval resumes the elder task', async () => {
  const approval = { status: 'needs_approval', spoken: 'घरवालों से पूछती हूँ', card: '22185 SL ₹180', approval_summary: 'Book 22185 SL tomorrow', amount_inr: 180, family_note: 'Maa wants to book a train' };
  const { handle, sent, agentCalls, store, msg } = setup([approval]);
  store.person(ELDER).language = 'hi';
  await handle(msg(ELDER, { kind: 'text', text: 'यही बुक करो' }));

  const ask = sent.find((s) => s.to === KID && s.type === 'buttons');
  assert.ok(ask, 'family got approval buttons');
  assert.match(ask.text, /₹180/);
  const approveId = ask.buttons.find((b) => b.startsWith('approve:'));

  await handle(msg(KID, { kind: 'button', buttonId: approveId, text: 'Approve' }));
  assert.match(agentCalls.at(-1).message, /FAMILY APPROVED: Book 22185 SL tomorrow/);

  // A second tap does nothing.
  await handle(msg(KID, { kind: 'button', buttonId: approveId, text: 'Approve' }));
  assert.match(sent.at(-1).text, /already approved/);
  assert.equal(agentCalls.length, 2);
});

test('the elder cannot approve by sending the button id', async () => {
  const approval = { status: 'needs_approval', spoken: 'x', card: '', approval_summary: 'Pay bill', amount_inr: 900, family_note: 'bill' };
  const { handle, agentCalls, store, msg, sent } = setup([approval]);
  store.person(ELDER).language = 'hi';
  await handle(msg(ELDER, { kind: 'text', text: 'बिल भर दो' }));
  const approveId = sent.find((s) => s.to === KID && s.type === 'buttons').buttons[0];
  await handle(msg(ELDER, { kind: 'button', buttonId: approveId, text: 'Approve' }));
  assert.ok(!agentCalls.some((c) => /FAMILY APPROVED/.test(c.message)));
});

test('scam warnings are copied to the family', async () => {
  const scam = { status: 'scam_warning', spoken: 'यह धोखा है', card: '', approval_summary: '', amount_inr: 0, family_note: 'Fake electricity disconnection SMS' };
  const { handle, sent, store, msg } = setup([scam]);
  store.person(ELDER).language = 'hi';
  await handle(msg(ELDER, { kind: 'text', text: 'आज रात बिजली कट जाएगी, इस नंबर पर कॉल करें' }));
  assert.ok(sent.some((s) => s.to === KID && /scam/.test(s.text)));
});

test('unknown numbers and duplicate deliveries are ignored', async () => {
  const { handle, sent, agentCalls, store, msg } = setup();
  await handle(msg('999', { kind: 'text', text: 'hi' }));
  assert.equal(sent.length, 0);

  store.person(ELDER).language = 'hi';
  const m = msg(ELDER, { kind: 'text', text: 'ट्रेन देखो' });
  await handle(m);
  await handle(m);
  assert.equal(agentCalls.length, 1);
});

test('agent failure still gives the elder a spoken reply', async () => {
  const { handle, sent, store, msg } = setup([], { failAgent: true });
  store.person(ELDER).language = 'hi';
  await handle(msg(ELDER, { kind: 'text', text: 'ट्रेन देखो' }));
  assert.equal(sent.at(-1).type, 'voice');
  assert.equal(sent.at(-1).to, ELDER);
});
