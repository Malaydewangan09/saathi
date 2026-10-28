// Languages offered only where both directions work: Deepgram understands it and macOS can speak it.
export const LANGUAGES = {
  hi: { name: 'Hindi', label: 'हिंदी', voice: 'Lekha' },
  en: { name: 'English', label: 'English', voice: 'Rishi' },
};

export const DEFAULT_LANGUAGE = 'hi';

export const PHRASES = {
  pick: 'नमस्ते, मैं साथी हूँ। आप किस भाषा में बात करना चाहेंगे?\nHello, I am Saathi. Which language would you like?',
  ack: { hi: 'जी, देख रही हूँ। बस एक मिनट।', en: 'Okay, I am looking. Just a minute.' },
  error: { hi: 'माफ़ कीजिए, अभी कुछ गड़बड़ हो गई। थोड़ी देर में फिर से बोलिए।', en: 'Sorry, something went wrong. Please try again in a little while.' },
  confirmAsk: { hi: 'क्या मैं यह करूँ?', en: 'Shall I go ahead?' },
  confirmHint: { hi: '(हाँ या नहीं बोलिए)', en: '(Just say yes or no)' },
  yes: { hi: 'हाँ', en: 'Yes' },
  no: { hi: 'नहीं', en: 'No' },
  confirmStale: { hi: 'यह पुराना सवाल था। फिर से बताइए, क्या करना है?', en: 'That question has expired. Tell me again what you need.' },
  unsupported: { hi: 'मैं अभी सिर्फ़ आवाज़ और लिखे हुए संदेश समझ पाती हूँ।', en: 'For now I understand voice notes and text messages.' },
};

export const phrase = (key, lang) => PHRASES[key][lang] || PHRASES[key][DEFAULT_LANGUAGE];
