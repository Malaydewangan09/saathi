import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const envFile = path.join(ROOT, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const env = process.env;

export const config = {
  port: Number(env.PORT) || 3000,
  dataDir: path.join(ROOT, 'data'),
  mcpUrl: env.SAATHI_MCP_URL || 'http://localhost:8931/mcp',
  model: env.SAATHI_MODEL || 'sonnet',
  agentTimeoutMs: Number(env.SAATHI_AGENT_TIMEOUT_MS) || 240_000,
  voice: env.SAATHI_VOICE || 'Lekha',
  deepgramKey: env.DEEPGRAM_API_KEY,
  whatsapp: {
    token: env.WHATSAPP_TOKEN,
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
    appSecret: env.WHATSAPP_APP_SECRET,
    verifyToken: env.WHATSAPP_VERIFY_TOKEN,
    apiVersion: env.WHATSAPP_API_VERSION || 'v25.0',
  },
  transport: env.SAATHI_TRANSPORT === 'twilio' ? 'twilio' : 'meta',
  playLocally: env.SAATHI_PLAY_LOCALLY === '1',
  publicUrl: (env.PUBLIC_URL || '').replace(/\/$/, ''),
  twilio: {
    accountSid: env.TWILIO_ACCOUNT_SID,
    authToken: env.TWILIO_AUTH_TOKEN,
    from: env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886',
  },
  // Numbers in international format without '+', e.g. 919812345678.
  // Only these numbers can talk to Saathi.
  numbers: list(env.SAATHI_NUMBERS),
};

function list(v) {
  return (v || '').split(',').map((s) => s.trim().replace(/^\+/, '')).filter(Boolean);
}

export function require_(...keys) {
  const missing = keys.filter((k) => !k.split('.').reduce((o, p) => o?.[p], config));
  if (missing.length) throw new Error(`missing config: ${missing.join(', ')} (see .env.example)`);
}
