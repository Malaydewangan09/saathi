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
  waitingFamily: { hi: 'मैंने आपके घरवालों से पूछ लिया है। उनका जवाब आते ही बताती हूँ।', en: 'I have asked your family. I will tell you as soon as they reply.' },
  unsupported: { hi: 'मैं अभी सिर्फ़ आवाज़ और लिखे हुए संदेश समझ पाती हूँ।', en: 'For now I understand voice notes and text messages.' },
};

export const phrase = (key, lang) => PHRASES[key][lang] || PHRASES[key][DEFAULT_LANGUAGE];
