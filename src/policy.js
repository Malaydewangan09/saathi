// Safety rules enforced in code, whatever the model returns.

export const STATUSES = ['done', 'needs_input', 'needs_approval', 'scam_warning'];
const MAX_SPOKEN = 600;
const MAX_CARD = 900;

export const REPLY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'spoken', 'card', 'approval_summary', 'amount_inr', 'family_note'],
  properties: {
    status: { type: 'string', enum: STATUSES },
    spoken: { type: 'string', description: 'What Saathi says in the voice note, in the user\'s language, short and warm.' },
    card: { type: 'string', description: 'Short text with the key facts (names, times, amounts). Empty if nothing to show.' },
    approval_summary: { type: 'string', description: 'One line for the family: what will happen if they approve. Empty unless needs_approval.' },
    amount_inr: { type: 'number', description: 'Money involved in rupees, 0 if none.' },
    family_note: { type: 'string', description: 'English note for the family. Required for needs_approval and scam_warning, else empty.' },
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
    approval_summary: clip(raw.approval_summary, 300),
    amount_inr: Number.isFinite(raw.amount_inr) && raw.amount_inr > 0 ? Math.round(raw.amount_inr) : 0,
    family_note: clip(raw.family_note, 300),
  };
  if (!reply.spoken) reply.spoken = 'माफ़ कीजिए, मैं समझ नहीं पाई। एक बार फिर से बताइए।';
  // An approval request must say what is being approved, or it is just a question.
  if (reply.status === 'needs_approval' && !reply.approval_summary) reply.status = 'needs_input';
  if ((reply.status === 'needs_approval' || reply.status === 'scam_warning') && !reply.family_note) {
    reply.family_note = reply.approval_summary || reply.card || reply.spoken;
  }
  return reply;
}

export function roleOf(number, { elderNumbers, familyNumbers }) {
  if (familyNumbers.includes(number)) return 'family';
  if (elderNumbers.includes(number)) return 'elder';
  return 'unknown';
}

function clip(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}
