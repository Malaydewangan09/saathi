import { DEFAULT_LANGUAGE, LANGUAGES, phrase, PHRASES } from './languages.js';

const NO = /(नहीं|नही|मत |मत$|रहने दो|cancel|\bno\b|\bnahi|\bnahin|\bmat\b|\brehne do)/i;
const YES = /(हाँ|हां|ठीक है|कर दो|कर दीजिए|कर दीजिये|बुक करो|\byes\b|\bhaan?\b|\bok(ay)?\b|\bkar do\b)/i;
const CHANGE = /(लेकिन|पर |दूसरी|दूसरा|बदल|instead|\bbut\b|\bother\b|\blekin\b|\bdoosri\b)/i;

const FRESH_AFTER_MS = 30 * 60 * 1000;

// Reads a short spoken or typed answer to "shall I go ahead?". Anything with a change in it is a new request, not a yes.
export function yesOrNo(text) {
  const t = text.trim().replace(/[.,!?।]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t || t.split(' ').length > 8) return null;
  if (NO.test(t)) return 'no';
  if (CHANGE.test(t)) return null;
  if (YES.test(t)) return 'yes';
  return null;
}

// One conversation turn per incoming message. Dependencies are passed in so tests can fake them.
export function createHandler({ store, wa, agent, voice, numbers, log = console, clock = Date.now, collage = null }) {
  const seen = new Set();
  const queues = new Map();

  // Webhooks are retried, so the same message can arrive twice.
  function firstTime(id) {
    if (seen.has(id)) return false;
    seen.add(id);
    if (seen.size > 5000) seen.delete(seen.values().next().value);
    return true;
  }

  // Messages from one person run one at a time, so the agent never works on two requests for them at once.
  function enqueue(number, job) {
    const prev = queues.get(number) || Promise.resolve();
    const next = prev.then(job).catch((err) => log.error(`[${number}] ${err.stack || err.message}`));
    queues.set(number, next);
    return next;
  }

  // The card rides along with the voice note where the channel allows it, to save a message.
  async function say(to, text, lang, caption = '') {
    // The voice follows the reply itself: Devanagari is spoken in Hindi, anything else in Indian English.
    const spokenIn = /[\u0900-\u097F]/.test(text) ? 'hi' : /[a-z]/i.test(text) ? 'en' : lang;
    const ogg = await voice.speak(text, LANGUAGES[spokenIn]?.voice);
    await wa.sendVoice(to, ogg, caption);
  }

  async function askLanguage(to) {
    await wa.sendButtons(to, PHRASES.pick, Object.entries(LANGUAGES).map(([id, l]) => ({ id: `lang:${id}`, title: l.label, aliases: [l.name] })));
  }

  async function toText(msg) {
    if (msg.kind === 'text') return msg.text.trim();
    const { data, mimeType } = await wa.downloadMedia(msg.mediaId);
    return voice.transcribe(data, mimeType);
  }

  async function runTurn(number, message) {
    const person = store.person(number);
    const lang = person.language || DEFAULT_LANGUAGE;
    // After a quiet spell, start a clean conversation: faster, cheaper, and old tasks do not leak into new ones.
    const now = clock();
    if (person.lastActive && now - person.lastActive > FRESH_AFTER_MS) person.sessionId = null;
    person.lastActive = now;
    const { reply, sessionId } = await agent.run({
      message: `[Reply language: ${LANGUAGES[lang].name}, unless the message below is clearly in another language]\n${message}`,
      sessionId: person.sessionId,
    });
    person.sessionId = sessionId;
    await store.save();
    log.info?.(`[${number.slice(-4)}] ${reply.status}: ${reply.spoken.slice(0, 160)}`);

    // Options people pick by look go out as one numbered picture, with the card as its caption.
    const picture = reply.images?.length && collage ? await collage(reply.images).catch((err) => {
      log.warn(`[${number.slice(-4)}] no picture: ${err.message}`);
      return null;
    }) : null;
    await say(number, reply.spoken, lang, picture ? '' : reply.card);
    if (picture) await wa.sendImage(number, picture, reply.card);

    // Anything that costs money or cannot be undone waits for the person's own yes.
    if (reply.status === 'needs_confirmation') {
      const id = store.createConfirmation({ owner: number, summary: reply.confirm_summary, amount: reply.amount_inr });
      await store.save();
      const amount = reply.amount_inr ? `\n₹${reply.amount_inr}` : '';
      await wa.sendButtons(number, `${reply.confirm_summary}${amount}\n\n${phrase('confirmAsk', lang)}`, [
        { id: `yes:${id}`, title: phrase('yes', lang), aliases: ['yes', 'हाँ', 'हां', 'haan'] },
        { id: `no:${id}`, title: phrase('no', lang), aliases: ['no', 'नहीं', 'nahi'] },
      ], phrase('confirmHint', lang));
    }
    return reply;
  }

  async function respond(number, text, lang) {
    // The ack is a courtesy: if it fails (rate limit, network), still do the task.
    await wa.sendText(number, phrase('ack', lang)).catch((err) => log.warn(`[${number.slice(-4)}] ack not sent: ${err.message}`));
    try {
      await runTurn(number, text);
    } catch (err) {
      log.error(`[${number}] agent: ${err.message}`);
      await say(number, phrase('error', lang), lang);
    }
  }

  async function confirm(number, id, decision, lang) {
    const res = store.resolveConfirmation(id, { decision, by: number });
    await store.save();
    if (!res.ok) return say(number, phrase('confirmStale', lang), lang);
    const { summary } = res.confirmation;
    const note = decision === 'yes'
      ? `USER CONFIRMED: ${summary}. Continue with exactly this action.`
      : `USER SAID NO: ${summary}. Do not do it. Tell them it is cancelled.`;
    await respond(number, note, lang);
  }

  async function fromUser(msg) {
    const person = store.person(msg.from);
    const lang = person.language || DEFAULT_LANGUAGE;

    if (msg.kind === 'button' && msg.buttonId.startsWith('lang:')) {
      const chosen = msg.buttonId.slice(5);
      if (!LANGUAGES[chosen]) return;
      person.language = chosen;
      const queued = person.queued;
      person.queued = null;
      await store.save();
      if (queued) await respond(msg.from, queued, chosen);
      else await say(msg.from, chosen === 'hi' ? 'ठीक है। बताइए, क्या करना है?' : 'Okay. Tell me what you need.', chosen);
      return;
    }
    const tapped = msg.kind === 'button' && msg.buttonId.match(/^(yes|no):(\w+)$/);
    if (tapped) return confirm(msg.from, tapped[2], tapped[1], lang);
    if (msg.kind !== 'text' && msg.kind !== 'audio') return say(msg.from, phrase('unsupported', lang), lang);

    const text = await toText(msg);
    if (msg.kind === 'audio') log.info?.(`[${msg.from.slice(-4)}] heard: ${text}`);
    if (!text) return say(msg.from, phrase('error', lang), lang);

    // A spoken or typed "हाँ" / "नहीं" answers the open question.
    const pending = store.pendingConfirmation(msg.from);
    const answer = pending && yesOrNo(text);
    if (answer) return confirm(msg.from, pending, answer, lang);

    // First contact: keep the request, ask the language, answer once it is picked.
    if (!person.language) {
      person.queued = text;
      await store.save();
      return askLanguage(msg.from);
    }
    await respond(msg.from, text, lang);
  }

  return async function handle(msg) {
    if (!firstTime(msg.id)) return;
    const allowed = typeof numbers === 'function' ? numbers(msg.from) : numbers.includes(msg.from);
    if (!allowed) return log.warn(`ignored message from unregistered number ending ${msg.from.slice(-4)}`);
    return enqueue(msg.from, () => fromUser(msg));
  };
}
