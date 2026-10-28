import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withLocalPlayback } from '../src/local.js';

function make({ fail }) {
  const lines = [];
  const played = [];
  const log = { log: (l) => lines.push(l), warn: (l) => lines.push(`WARN ${l}`) };
  const transport = {
    sendText: async () => { if (fail) throw new Error('Twilio 429'); return 'sent'; },
    sendButtons: async () => { if (fail) throw new Error('Twilio 429'); return 'sent'; },
    sendVoice: async () => { if (fail) throw new Error('Twilio 429'); return 'sent'; },
    downloadMedia: async () => 'media',
  };
  transport.sendImage = async () => { if (fail) throw new Error('Twilio 429'); return 'sent'; };
  const t = withLocalPlayback(transport, { log, play: async (ogg) => played.push(ogg), show: async (jpg) => played.push(jpg) });
  return { t, lines, played };
}

test('when sending works, nothing plays locally', async () => {
  const { t, played } = make({ fail: false });
  assert.equal(await t.sendVoice('911', Buffer.from('ogg'), 'card'), 'sent');
  assert.equal(played.length, 0);
});

test('when the channel refuses, the voice note plays here and the card is printed', async () => {
  const { t, lines, played } = make({ fail: true });
  await t.sendVoice('911', Buffer.from('ogg'), '12409 SL ₹640');
  assert.equal(played.length, 1);
  assert.ok(lines.some((l) => l.includes('12409 SL ₹640')));
});

test('refused texts and choices are printed, other methods pass through', async () => {
  const { t, lines } = make({ fail: true });
  await t.sendText('911', 'जी, देख रही हूँ।');
  await t.sendButtons('911', 'क्या मैं यह करूँ?', [{ title: 'हाँ' }, { title: 'नहीं' }]);
  assert.ok(lines.some((l) => l.includes('जी, देख रही हूँ।')));
  assert.ok(lines.some((l) => l.includes('1. हाँ')));
  assert.equal(await t.downloadMedia('x'), 'media');
});

test('a refused picture opens here, with its card printed', async () => {
  const { t, lines, played } = make({ fail: true });
  await t.sendImage('911', Buffer.from('jpg'), '1. Homesake ₹1,549');
  assert.equal(played.length, 1);
  assert.ok(lines.some((l) => l.includes('Homesake')));
});
