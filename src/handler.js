import { roleOf } from './policy.js';
import { DEFAULT_LANGUAGE, LANGUAGES, phrase, PHRASES } from './languages.js';

// One conversation turn per incoming message. Dependencies are passed in so tests can fake them.
export function createHandler({ store, wa, agent, voice, numbers, log = console }) {
  const seen = new Set();
  const queues = new Map();

  // Meta retries webhooks, so the same message can arrive twice.
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

  async function say(to, text, lang) {
    const ogg = await voice.speak(text, LANGUAGES[lang]?.voice);
    await wa.sendVoice(to, ogg);
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
    const { reply, sessionId } = await agent.run({
      message: `[Reply language: ${LANGUAGES[lang].name}]\n${message}`,
      sessionId: person.sessionId,
    });
    person.sessionId = sessionId;
    await store.save();
    log.info?.(`[${number.slice(-4)}] ${reply.status}: ${reply.spoken.slice(0, 160)}`);

    await say(number, reply.spoken, lang);
    if (reply.card) await wa.sendText(number, reply.card);

    if (reply.status === 'needs_approval') {
      const id = store.createApproval({ elder: number, summary: reply.approval_summary, amount: reply.amount_inr });
      await store.save();
      const text = `Saathi needs your OK\n\n${reply.family_note}\n\n${reply.approval_summary}${reply.amount_inr ? `\nAmount: ₹${reply.amount_inr}` : ''}`;
      for (const f of numbers.familyNumbers) {
        await wa.sendButtons(f, text, [{ id: `approve:${id}`, title: 'Approve' }, { id: `decline:${id}`, title: 'Decline' }]);
      }
      await wa.sendText(number, phrase('waitingFamily', lang));
    }
    if (reply.status === 'scam_warning') {
      for (const f of numbers.familyNumbers) await wa.sendText(f, `Saathi stopped a likely scam\n\n${reply.family_note}`);
    }
    return reply;
  }

  async function fromElder(msg) {
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
    if (msg.kind !== 'text' && msg.kind !== 'audio') return say(msg.from, phrase('unsupported', lang), lang);

    const text = await toText(msg);
    if (!text) return say(msg.from, phrase('error', lang), lang);

    // First contact: keep the request, ask the language, answer once it is picked.
    if (!person.language) {
      person.queued = text;
      await store.save();
      return askLanguage(msg.from);
    }
    await respond(msg.from, text, lang);
  }

  async function respond(number, text, lang) {
    await wa.sendText(number, phrase('ack', lang));
    try {
      await runTurn(number, text);
    } catch (err) {
      log.error(`[${number}] agent: ${err.message}`);
      await say(number, phrase('error', lang), lang);
    }
  }

  async function fromFamily(msg) {
    const [decision, id] = (msg.buttonId || '').split(':');
    if (msg.kind !== 'button' || !['approve', 'decline'].includes(decision)) {
      return wa.sendText(msg.from, 'Saathi sends you approval requests here. Tap Approve or Decline when one arrives.');
    }
    const res = store.resolveApproval(id, { decision, by: msg.from, isFamily: true });
    await store.save();
    if (!res.ok) return wa.sendText(msg.from, `Could not apply that: ${res.reason}.`);

    const { elder, summary } = res.approval;
    await wa.sendText(msg.from, decision === 'approve' ? `Approved. Saathi will continue: ${summary}` : 'Declined. Saathi will let them know.');
    const lang = store.person(elder).language || DEFAULT_LANGUAGE;
    const note = decision === 'approve' ? `FAMILY APPROVED: ${summary}. Continue with exactly this action.` : `FAMILY DECLINED: ${summary}. Do not do it.`;
    await enqueue(elder, () => respond(elder, note, lang));
  }

  return async function handle(msg) {
    if (!firstTime(msg.id)) return;
    const role = roleOf(msg.from, numbers);
    if (role === 'unknown') return log.warn(`ignored message from unregistered number ending ${msg.from.slice(-4)}`);
    // A family member who is also listed as elder (single-phone testing) still gets approvals routed as family.
    if (role === 'family' && msg.kind === 'button' && /^(approve|decline):/.test(msg.buttonId)) return fromFamily(msg);
    if (role === 'family' && !numbers.elderNumbers.includes(msg.from)) return fromFamily(msg);
    return enqueue(msg.from, () => fromElder(msg));
  };
}
