import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

// Plays the reply on this Mac when the channel refuses it (e.g. Twilio's daily trial limit), so testing can go on.
export function withLocalPlayback(transport, { log = console, play = playOgg } = {}) {
  const fallback = (what, show) => async (...args) => {
    try {
      return await transport[what](...args);
    } catch (err) {
      log.warn(`${what} failed (${err.message.slice(0, 80)}), showing it here instead`);
      await show(...args);
      return null;
    }
  };
  return {
    ...transport,
    sendText: fallback('sendText', (_to, text) => log.log(`  [text] ${text}`)),
    sendButtons: fallback('sendButtons', (_to, text, buttons) =>
      log.log(`  [choice] ${text}\n${buttons.map((b, i) => `    ${i + 1}. ${b.title}`).join('\n')}`)),
    sendVoice: fallback('sendVoice', async (_to, ogg, caption) => {
      if (caption) log.log(`  [card] ${caption}`);
      await play(ogg);
    }),
  };
}

async function playOgg(ogg) {
  const dir = await mkdtemp(path.join(tmpdir(), 'saathi-play-'));
  try {
    const file = path.join(dir, 'reply.ogg');
    await writeFile(file, ogg);
    // afplay cannot read Ogg Opus, so convert to WAV first.
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', file, path.join(dir, 'reply.wav')]);
    await run('afplay', [path.join(dir, 'reply.wav')]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
