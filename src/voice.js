import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { config, require_ } from './config.js';

const run = promisify(execFile);
const DEEPGRAM_URL = 'https://api.deepgram.com/v1/listen?model=nova-3&language=multi&smart_format=true&punctuate=true';

// Voice note (WhatsApp sends audio/ogg; codecs=opus) to text. 'multi' handles Hindi-English mixing.
export async function transcribe(audio, mimeType = 'audio/ogg') {
  require_('deepgramKey');
  const res = await fetch(DEEPGRAM_URL, {
    method: 'POST',
    headers: { Authorization: `Token ${config.deepgramKey}`, 'Content-Type': mimeType.split(';')[0] },
    body: audio,
  });
  if (!res.ok) throw new Error(`Deepgram ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() || '';
}

// Text to an OGG/Opus voice note, the format WhatsApp plays as a voice message.
export async function speak(text, voice = config.voice) {
  const dir = await mkdtemp(path.join(tmpdir(), 'saathi-'));
  try {
    const aiff = path.join(dir, 'reply.aiff');
    const ogg = path.join(dir, 'reply.ogg');
    await run('say', ['-v', voice, '-r', '165', '-o', aiff, text]);
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', aiff, '-ac', '1', '-ar', '16000', '-c:a', 'libopus', '-b:a', '24k', ogg]);
    return await readFile(ogg);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
