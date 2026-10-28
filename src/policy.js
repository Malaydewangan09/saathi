// Safety rules enforced in code, whatever the model returns.

export const STATUSES = ['done', 'needs_input', 'needs_confirmation', 'scam_warning'];
const MAX_SPOKEN = 600;
const MAX_CARD = 1500;

export const REPLY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'spoken', 'card', 'confirm_summary', 'amount_inr', 'images'],
  properties: {
    status: { type: 'string', enum: STATUSES },
    spoken: { type: 'string', description: 'What Saathi says in the voice note, in the user\'s language, short and warm.' },
    card: { type: 'string', description: 'Short text with the key facts (names, times, amounts). Empty if nothing to show.' },
    confirm_summary: { type: 'string', description: 'One short line in the user\'s language: exactly what will happen if they say yes. Empty unless needs_confirmation.' },
    amount_inr: { type: 'number', description: 'Money involved in rupees, 0 if none.' },
    images: {
      type: 'array',
      items: { type: 'string' },
      description: 'Direct https image URLs of the options shown, in the same order as their numbers in the card, at most 4. Empty if none.',
    },
  },
};

// Validates and repairs a model reply so downstream code can trust its shape.
export function normalizeReply(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('agent returned no reply');
  const status = STATUSES.includes(raw.status) ? raw.status : 'needs_input';
  const reply = {
    status,
    spoken: clip(raw.spoken, MAX_SPOKEN),
    card: clip(raw.card, MAX_CARD),
    confirm_summary: clip(raw.confirm_summary, 300),
    amount_inr: Number.isFinite(raw.amount_inr) && raw.amount_inr > 0 ? Math.round(raw.amount_inr) : 0,
    images: Array.isArray(raw.images) ? raw.images.filter((u) => typeof u === 'string' && u.startsWith('https://')).slice(0, 4) : [],
  };
  if (!reply.spoken) reply.spoken = 'माफ़ कीजिए, मैं समझ नहीं पाई। एक बार फिर से बताइए।';
  // A confirmation must say what is being confirmed, or it is just a question.
  if (reply.status === 'needs_confirmation' && !reply.confirm_summary) reply.status = 'needs_input';
  return reply;
}

function clip(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}
