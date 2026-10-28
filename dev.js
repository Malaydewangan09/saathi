#!/usr/bin/env node
// Talk to Saathi from the terminal, no WhatsApp needed.
//   node dev.js "कल सुबह पुणे के लिए ट्रेन देखो"
//   node dev.js --audio note.ogg
//   node dev.js --say "बेटा, ट्रेन देखो"     (speaks it with the Hindi voice first, to test the voice path)
import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import { config } from './src/config.js';
import { runAgent } from './src/agent.js';
import { speak, transcribe } from './src/voice.js';

const run = promisify(execFile);
const SESSION_FILE = path.join(config.dataDir, 'dev-session.txt');

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { audio: { type: 'string' }, say: { type: 'string' }, new: { type: 'boolean' }, mute: { type: 'boolean' } },
});

await mkdir(config.dataDir, { recursive: true });
const sessionId = values.new ? undefined : await readFile(SESSION_FILE, 'utf8').catch(() => undefined);

let message = positionals.join(' ');
if (values.say) message = await transcribe(await speak(values.say), 'audio/ogg');
else if (values.audio) message = await transcribe(await readFile(values.audio), 'audio/ogg');
if (!message) {
  console.error('usage: node dev.js "<message>" | --audio note.ogg | --say "<text>"  [--new] [--mute]');
  process.exit(1);
}

console.log(`\nMaa: ${message}\n...`);
const started = Date.now();
const { reply, sessionId: next } = await runAgent({ message, sessionId });
await writeFile(SESSION_FILE, next);

console.log(`\nSaathi [${reply.status}] (${Math.round((Date.now() - started) / 1000)}s)`);
console.log(`  says : ${reply.spoken}`);
if (reply.card) console.log(`  card : ${reply.card.replace(/\n/g, '\n         ')}`);
if (reply.status === 'needs_confirmation') console.log(`  asks : ${reply.confirm_summary}${reply.amount_inr ? ` (₹${reply.amount_inr})` : ''}  -> reply with: node dev.js "USER CONFIRMED: ..."`);

if (!values.mute) {
  const file = path.join(config.dataDir, 'last-reply.ogg');
  await writeFile(file, await speak(reply.spoken));
  await run('afplay', [file]).catch(() => {});
}
