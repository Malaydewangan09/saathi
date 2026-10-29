import { createCloudChat } from '../src/cloud.js';

export const config = { maxDuration: 60 };

const chat = createCloudChat({
  apiKey: process.env.GROQ_API_KEY,
  origins: (process.env.SAATHI_WEB_ORIGIN || 'https://malaydewangan09.github.io').split(','),
  perVisitor: Number(process.env.SAATHI_WEB_PER_VISITOR) || 3,
});

// Vercel function behind the website's live chat. Only the Saathi website may call it.
export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (chat.allowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(chat.allowedOrigin(origin) ? 204 : 403).end();
  }
  if (!chat.allowedOrigin(origin)) return res.status(403).json({ error: 'origin not allowed' });
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET') return res.status(200).json({ online: true, mode: 'cloud' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const [status, body] = await chat.ask(req.body || {}, { ip });
  return res.status(status).json(body);
}
