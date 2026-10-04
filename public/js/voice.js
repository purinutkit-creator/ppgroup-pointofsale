// Queue call announcements: chime (Web Audio) + speech (Web Speech API).

const TH_DIGITS = ['ศูนย์', 'หนึ่ง', 'สอง', 'สาม', 'สี่', 'ห้า', 'หก', 'เจ็ด', 'แปด', 'เก้า'];
const TH_LETTERS = {
  A: 'เอ', B: 'บี', C: 'ซี', D: 'ดี', E: 'อี', F: 'เอฟ', G: 'จี', H: 'เอช', I: 'ไอ', J: 'เจ', K: 'เค', L: 'แอล', M: 'เอ็ม',
  N: 'เอ็น', O: 'โอ', P: 'พี', Q: 'คิว', R: 'อาร์', S: 'เอส', T: 'ที', U: 'ยู', V: 'วี', W: 'ดับเบิลยู', X: 'เอ็กซ์', Y: 'วาย', Z: 'แซด',
};
const EN_DIGITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

/** "B026" → "บี ศูนย์ สอง หก" (digit by digit, as announced in restaurants). */
export function spellThai(q) {
  return [...String(q)].map((c) => (/\d/.test(c) ? TH_DIGITS[+c] : TH_LETTERS[c.toUpperCase()] || c)).join(' ');
}
export function spellEnglish(q) {
  return [...String(q)].map((c) => (/\d/.test(c) ? EN_DIGITS[+c] : c.toUpperCase())).join(' ');
}

let audioCtx = null;
function ctx() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    audioCtx = new AC();
  }
  return audioCtx;
}

/** Must be called once from a user gesture so browsers allow audio playback. */
export function unlockAudio() {
  const c = ctx();
  if (c && c.state === 'suspended') c.resume();
  if ('speechSynthesis' in window) {
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    window.speechSynthesis.speak(u);
  }
  return !c || c.state !== 'suspended';
}
export function audioUnlocked() {
  const c = ctx();
  return !!c && c.state === 'running';
}

/** Two-tone "ding-dong" chime. */
export function chime(volume = 0.9) {
  const c = ctx();
  if (!c) return Promise.resolve();
  if (c.state === 'suspended') c.resume();
  const now = c.currentTime;
  const notes = [[880, 0], [659.25, 0.42]];
  for (const [freq, t] of notes) {
    for (const [mult, gainMul] of [[1, 1], [2, 0.25], [3, 0.08]]) {
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = 'sine';
      o.frequency.value = freq * mult;
      g.gain.setValueAtTime(0, now + t);
      g.gain.linearRampToValueAtTime(0.35 * volume * gainMul, now + t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, now + t + 1.3);
      o.connect(g).connect(c.destination);
      o.start(now + t);
      o.stop(now + t + 1.4);
    }
  }
  return new Promise((r) => setTimeout(r, 1500));
}

function pickVoice(lang) {
  const voices = window.speechSynthesis.getVoices();
  return voices.find((v) => v.lang === lang) || voices.find((v) => v.lang && v.lang.startsWith(lang.slice(0, 2))) || null;
}

function speak(text, lang, { volume = 1, rate = 0.9 } = {}) {
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window)) return resolve();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    const v = pickVoice(lang);
    if (v) u.voice = v;
    u.volume = volume;
    u.rate = rate;
    const done = () => { clearTimeout(t); resolve(); };
    const t = setTimeout(done, 15000);
    u.onend = done;
    u.onerror = done;
    window.speechSynthesis.speak(u);
  });
}

if ('speechSynthesis' in window) {
  window.speechSynthesis.getVoices();
  window.speechSynthesis.onvoiceschanged = () => window.speechSynthesis.getVoices();
}

let queue = Promise.resolve();

/** Announce a queue number according to the store's sound settings. Calls are serialized. */
export function announce(queueNumber, s) {
  if (!s || !s.sound_enabled) return Promise.resolve();
  queue = queue.then(async () => {
    const volume = (s.sound_volume ?? 90) / 100;
    const rate = (s.sound_rate ?? 9) / 10;
    for (let i = 0; i < (s.sound_repeat || 1); i += 1) {
      if (s.sound_chime && i === 0) await chime(volume);
      if (s.sound_voice === 'th' || s.sound_voice === 'th_en') {
        await speak((s.sound_template_th || '{queue}').replaceAll('{queue}', spellThai(queueNumber)), 'th-TH', { volume, rate });
      }
      if (s.sound_voice === 'en' || s.sound_voice === 'th_en') {
        await speak((s.sound_template_en || '{queue}').replaceAll('{queue}', spellEnglish(queueNumber)), 'en-US', { volume, rate });
      }
      if (i < s.sound_repeat - 1) await new Promise((r) => setTimeout(r, 700));
    }
  }).catch(() => {});
  return queue;
}
