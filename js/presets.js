'use strict';
/*
 * Theory — chords, scales and voicing.
 * Chords are written as Roman numerals relative to the song key (I, ii7, IVmaj7, bVII, V7 ...)
 * so changing the key transposes the whole song. Plain chord names (Am, F, G7) also work.
 * Bars are separated by "|"; put two chords in one bar with a space: "I | IV | ii7 V7".
 */
const Theory = (() => {
  const NOTES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  const SCALES = {
    major: [0, 2, 4, 5, 7, 9, 11],
    minor: [0, 2, 3, 5, 7, 8, 10],
    dorian: [0, 2, 3, 5, 7, 9, 10],
    mixolydian: [0, 2, 4, 5, 7, 9, 10],
    harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
    pentMajor: [0, 2, 4, 7, 9],
    pentMinor: [0, 3, 5, 7, 10],
    blues: [0, 3, 5, 6, 7, 10]
  };
  const SCALE_NAMES = {
    major: 'Major', minor: 'Minor', dorian: 'Dorian', mixolydian: 'Mixolydian',
    harmonicMinor: 'Harmonic minor', pentMajor: 'Pentatonic major', pentMinor: 'Pentatonic minor', blues: 'Blues'
  };
  const ROMAN = { I: 0, II: 2, III: 4, IV: 5, V: 7, VI: 9, VII: 11 };
  const LETTER = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const ROMAN_RE = /^([b#♭♯]?)(VII|VI|IV|V|III|II|I|vii|vi|iv|v|iii|ii|i)(.*)$/;
  const LETTER_RE = /^([A-G])([b#♭♯]?)(.*)$/;

  function intervals(minor, s) {
    const tri = minor ? [0, 3, 7] : [0, 4, 7];
    switch (s) {
      case '': return tri;
      case '7': return [...tri, 10];
      case 'maj7': case 'M7': case 'Δ': case 'Δ7': return [...tri, 11];
      case '9': return [...tri, 10, 14];
      case 'maj9': case 'M9': return [...tri, 11, 14];
      case 'add9': case '2': return [...tri, 14];
      case '6': return [...tri, 9];
      case '11': return [...tri, 10, 14, 17];
      case 'sus2': return [0, 2, 7];
      case 'sus4': case 'sus': return [0, 5, 7];
      case '7sus4': case '7sus': return [0, 5, 7, 10];
      case 'dim': case 'o': case '°': return [0, 3, 6];
      case 'dim7': case 'o7': case '°7': return [0, 3, 6, 9];
      case 'ø': case 'ø7': case '7b5': case 'm7b5': return [0, 3, 6, 10];
      case 'aug': case '+': return [0, 4, 8];
      default: return null;
    }
  }

  const chordCache = new Map();
  // Returns {root (semitones above key), iv (intervals), minor, suffix} or null if not understood.
  function parseChord(sym, key) {
    if (!sym) return null;
    const ck = key + '|' + sym;
    if (chordCache.has(ck)) return chordCache.get(ck);
    let res = null;
    const clean = sym.split('/')[0].trim();
    let m = clean.match(ROMAN_RE);
    if (m) {
      const acc = (m[1] === 'b' || m[1] === '♭') ? -1 : (m[1] ? 1 : 0);
      const minor = m[2] === m[2].toLowerCase();
      const root = ((ROMAN[m[2].toUpperCase()] + acc) % 12 + 12) % 12;
      const iv = intervals(minor, m[3]);
      if (iv) res = { root, iv, minor, suffix: m[3] };
    } else if ((m = clean.match(LETTER_RE))) {
      const acc = (m[2] === 'b' || m[2] === '♭') ? -1 : (m[2] ? 1 : 0);
      let suf = m[3];
      let minor = false;
      if (suf.startsWith('m') && !suf.startsWith('maj')) { minor = true; suf = suf.slice(1); }
      const root = ((LETTER[m[1]] + acc - key) % 12 + 24) % 12;
      const iv = intervals(minor, suf);
      if (iv) res = { root, iv, minor, suffix: suf };
    }
    chordCache.set(ck, res);
    return res;
  }

  const progCache = new Map();
  // "I | V | vi IV" -> [['I'], ['V'], ['vi','IV']]. "%" or "-" repeats the previous chord.
  function parseProgression(text) {
    if (progCache.has(text)) return progCache.get(text);
    let prev = 'I';
    const bars = String(text || '').split('|').map(b => b.trim()).filter(Boolean).map(b =>
      b.split(/\s+/).slice(0, 4).map(tok => {
        if (tok === '%' || tok === '-') return prev;
        prev = tok;
        return tok;
      }));
    const out = bars.length ? bars : [['I']];
    progCache.set(text, out);
    return out;
  }

  // Chord tones voiced close together around `center` (MIDI), choosing the smoothest inversion.
  function voice(key, ch, center = 62) {
    const rootPc = (key + ch.root) % 12;
    let base = center - 7;
    base += ((rootPc - base) % 12 + 12) % 12;
    const notes = ch.iv.map(i => base + i);
    let best = notes, bestD = Infinity;
    for (let inv = -2; inv <= notes.length; inv++) {
      const c = notes.slice();
      for (let k = 0; k < Math.abs(inv); k++) {
        c.sort((a, b) => a - b);
        if (inv > 0) c[0] += 12; else c[c.length - 1] -= 12;
      }
      c.sort((a, b) => a - b);
      const avg = c.reduce((a, b) => a + b, 0) / c.length;
      const d = Math.abs(avg - center) + (c[c.length - 1] - c[0] > 19 ? 6 : 0);
      if (d < bestD) { bestD = d; best = c; }
    }
    return best;
  }

  function bassRoot(key, ch, low = 33) {
    const pc = (key + ch.root) % 12;
    return low + ((pc - low) % 12 + 12) % 12;
  }

  function chordName(key, sym) {
    const ch = parseChord(sym, key);
    if (!ch) return null;
    const name = NOTES[(key + ch.root) % 12];
    const s = ch.suffix;
    const isDim = /^(dim|o|°|ø|m7b5|7b5)/.test(s);
    return name + (ch.minor && !isDim ? 'm' : '') + s;
  }

  function degreeMidi(key, scale, row) {
    const sc = SCALES[scale] || SCALES.major;
    const base = 60 + (key >= 6 ? key - 12 : key);
    return base + sc[row % sc.length] + 12 * Math.floor(row / sc.length);
  }

  function noteName(m) { return NOTES[m % 12] + (Math.floor(m / 12) - 1); }

  return { NOTES, SCALES, SCALE_NAMES, parseChord, parseProgression, voice, bassRoot, chordName, degreeMidi, noteName };
})();

/*
 * Presets — genre starting points, drum grooves and chord progressions.
 */
const Presets = (() => {
  const MEL_ROWS = 15;
  let counter = 0;
  const uid = p => p + Date.now().toString(36).slice(-4) + Math.random().toString(36).slice(2, 7) + (counter++).toString(36);

  // Drum pattern strings: x = hit, o = soft ghost note, 2/3/4 = roll (ratchet), . = rest
  function pat(str = '') {
    const a = new Array(16).fill(0);
    for (let i = 0; i < 16; i++) {
      const c = str[i];
      if (!c || c === '.' || c === '-') continue;
      a[i] = c === 'o' ? 0.5 : (c >= '2' && c <= '4') ? +c : 1;
    }
    return a;
  }
  function drums(obj = {}) {
    const d = {};
    Synth.DRUMS.forEach(k => { d[k] = pat(obj[k]); });
    return d;
  }
  function emptyMelody(len = 32) { return Array.from({ length: MEL_ROWS }, () => new Array(len).fill(0)); }
  // notes: [step, row, length]
  function melody(len, notes) {
    const m = emptyMelody(len);
    notes.forEach(([s, r, l = 1]) => {
      m[r][s] = 1;
      for (let i = 1; i < l; i++) if (s + i < len) m[r][s + i] = 2;
    });
    return m;
  }
  function section(name, bars, prog, dr, o = {}) {
    const s = Object.assign({
      id: uid('s_'), name, bars, prog,
      drums: drums(dr || {}), drumsOn: !!dr,
      bassOn: true, keysOn: true, padOn: false, melodyOn: false,
      keysStyle: 'block', bassStyle: 'root',
      melodyLen: 32, melody: null
    }, o);
    if (!s.melody) s.melody = emptyMelody(s.melodyLen);
    s.melodyLen = s.melody[0].length;
    return s;
  }
  function channel(o = {}) {
    return Object.assign({ vol: 0.7, pan: 0, mute: false, solo: false, hp: false, low: 0, mid: 0, high: 0, comp: 0, reverb: 0.1, delay: 0 }, o);
  }
  function song(settings, secs, order) {
    const sections = Object.values(secs);
    return {
      version: 1,
      name: settings.name,
      genre: settings.genre,
      bpm: settings.bpm,
      key: settings.key,
      scale: settings.scale || 'major',
      swing: settings.swing || 0,
      swingGrid: settings.swingGrid || '16',
      kit: settings.kit,
      inst: Object.assign({ keys: 'piano', pad: 'pad', bass: 'electric', melody: 'bell' }, settings.inst),
      drumVol: Object.fromEntries(Synth.DRUMS.map(k => [k, 0.8])),
      mix: {
        drums: channel({ vol: 0.75, reverb: 0.05 }),
        bass: channel({ vol: 0.7, reverb: 0 }),
        keys: channel({ vol: 0.62, reverb: 0.18 }),
        pad: channel({ vol: 0.55, reverb: 0.35 }),
        melody: channel({ vol: 0.6, reverb: 0.22, delay: 0.12 }),
        ...(settings.mix || {})
      },
      master: { vol: 0.85, glue: true, loud: 3 },
      sections,
      arrangement: order.map(n => secs[n].id),
      tracks: []
    };
  }

  const GENRES = [
    {
      id: 'worship', name: 'Worship', icon: '🙏', desc: 'Piano ballad with warm pad, building to a full chorus',
      build() {
        const s = {
          intro: section('Intro', 4, 'I | V | vi | IV', null, { padOn: true, bassOn: false }),
          verse: section('Verse', 8, 'I | V | vi | IV', { kick: 'x.......x.......', perc: '....x.......x...', hat: 'x.x.x.x.x.x.x.x.' }, { keysStyle: 'ballad', padOn: true }),
          chorus: section('Chorus', 8, 'IV | I | V | vi', { kick: 'x.....x.x.......', snare: '....x.......x...', hat: 'x.x.x.x.x.x.x.x.', ohat: '..............x.' }, { keysStyle: 'pulse', padOn: true, bassStyle: 'pulse8' }),
          bridge: section('Bridge', 8, 'vi | IV | I | V', { kick: 'x...x...x...x...', tom: '..x...x...x..xx.', ride: 'x...x...x...x...' }, { keysStyle: 'pulse', padOn: true }),
          outro: section('Outro', 4, 'IV | I', null, { padOn: true, bassOn: false })
        };
        return song({ name: 'My Worship Song', genre: 'worship', bpm: 72, key: 7, kit: 'acoustic', inst: { keys: 'piano', pad: 'pad', bass: 'electric', melody: 'bell' } },
          s, ['intro', 'verse', 'chorus', 'verse', 'chorus', 'bridge', 'chorus', 'outro']);
      }
    },
    {
      id: 'trap', name: 'Rap / Trap', icon: '🎤', desc: '808 bass, rolling hi-hats, dark minor bells',
      build() {
        const prog = 'i | bVI | bIII | bVII';
        const mel = melody(32, [[0, 7, 2], [3, 7, 1], [6, 9, 2], [8, 8, 2], [11, 7, 2], [14, 4, 2], [16, 5, 2], [19, 5, 1], [22, 4, 2], [24, 4, 3], [28, 2, 2], [30, 4, 2]]);
        const s = {
          intro: section('Intro', 4, prog, null, { keysOn: false, padOn: true, bassOn: false, melodyOn: true, melody: mel }),
          hook: section('Hook', 8, prog, { kick: 'x......x..x.....', snare: '........x.......', clap: '........x.......', hat: 'x.x.x.x2x.x.x3x.' }, { keysStyle: 'arp', bassStyle: '808', melodyOn: true, melody: mel }),
          verse: section('Verse', 8, prog, { kick: 'x.........x..x..', snare: '........x.......', hat: 'x.xxx.x.x.xxx3x.', perc: '...x......x.....' }, { keysOn: false, padOn: true, bassStyle: '808' })
        };
        return song({ name: 'My Rap Beat', genre: 'trap', bpm: 140, key: 5, scale: 'minor', kit: '808', inst: { keys: 'pluck', pad: 'pad', bass: '808', melody: 'bell' }, mix: { bass: channel({ vol: 0.75, reverb: 0 }) } },
          s, ['intro', 'hook', 'verse', 'hook', 'verse', 'hook', 'intro']);
      }
    },
    {
      id: 'boombap', name: 'Hip-Hop (Boom Bap)', icon: '🎧', desc: 'Swung drums, jazzy Rhodes chords, upright bass',
      build() {
        const prog = 'ii9 | V7 | Imaj7 | vi7';
        const dr = { kick: 'x.....x...x..x..', snare: '....x.......x...', hat: 'x.x.x.x.x.x.x.xo' };
        const s = {
          intro: section('Intro', 4, prog, null, { bassOn: false }),
          verse: section('Verse', 8, prog, dr, { bassStyle: 'syncopated' }),
          hook: section('Hook', 8, prog, Object.assign({ ohat: '......x.......x.' }, dr), { padOn: true, bassStyle: 'syncopated' })
        };
        return song({ name: 'My Hip-Hop Beat', genre: 'boombap', bpm: 90, key: 5, swing: 0.55, kit: 'lofi', inst: { keys: 'epiano', pad: 'strings', bass: 'upright', melody: 'flute' } },
          s, ['intro', 'verse', 'hook', 'verse', 'hook', 'intro']);
      }
    },
    {
      id: 'jazz', name: 'Jazz', icon: '🎷', desc: 'Swing ride cymbal, walking bass, piano comping',
      build() {
        const dr = { ride: 'x...x.x.x...x.x.', hat: '....x.......x...', kick: 'x.......x.......', snare: '......o.......o.' };
        const s = {
          intro: section('Intro', 4, 'ii7 | V7 | ii7 | V7', { ride: 'x...x.x.x...x.x.', hat: '....x.......x...' }, { keysStyle: 'comp', bassStyle: 'walking' }),
          a: section('A Section', 8, 'ii7 | V7 | Imaj7 | VI7 | ii7 | V7 | Imaj7 | Imaj7', dr, { keysStyle: 'comp', bassStyle: 'walking' }),
          b: section('B Section', 8, 'iv7 | bVII7 | Imaj7 | VI7 | ii7 | V7 | iii7 VI7 | ii7 V7', dr, { keysStyle: 'comp', bassStyle: 'walking' }),
          end: section('Ending', 4, 'ii7 | V7 | Imaj7 | Imaj7', { ride: 'x...x.x.x...x...', hat: '....x.......x...' }, { keysStyle: 'block', bassStyle: 'root' })
        };
        return song({ name: 'My Jazz Tune', genre: 'jazz', bpm: 132, key: 10, swing: 1, swingGrid: '8', kit: 'jazz', inst: { keys: 'piano', pad: 'strings', bass: 'upright', melody: 'flute' } },
          s, ['intro', 'a', 'a', 'b', 'a', 'end']);
      }
    },
    {
      id: 'classical', name: 'Classical', icon: '🎻', desc: 'Strings and piano arpeggios, no drums',
      build() {
        const theme = melody(128, [[0, 9, 16], [16, 8, 16], [32, 7, 16], [48, 6, 16], [64, 5, 16], [80, 4, 16], [96, 5, 16], [112, 6, 16]]);
        const s = {
          intro: section('Introduction', 4, 'I | V | vi | iii', null, { keysOn: false, padOn: true }),
          a: section('Theme A', 8, 'I | V | vi | iii | IV | I | IV | V', null, { keysStyle: 'arp', padOn: true, melodyOn: true, melody: theme }),
          b: section('Theme B', 8, 'vi | iii | IV | I | ii | V | I | V7', null, { keysStyle: 'broken', padOn: true }),
          coda: section('Coda', 4, 'IV | V7 | I | I', null, { keysStyle: 'block', padOn: true })
        };
        return song({ name: 'My Classical Piece', genre: 'classical', bpm: 76, key: 2, kit: 'acoustic', inst: { keys: 'piano', pad: 'strings', bass: 'cello', melody: 'flute' }, mix: { pad: channel({ vol: 0.6, reverb: 0.4 }) } },
          s, ['intro', 'a', 'b', 'a', 'coda']);
      }
    },
    {
      id: 'gospel', name: 'Gospel', icon: '⛪', desc: 'Organ, choir, shuffle groove with a vamp',
      build() {
        const dr = { kick: 'x......x.x......', snare: '....x.......x...', hat: 'x.xox.xox.xox.xo' };
        const s = {
          intro: section('Intro', 4, 'I | IV | I | V7', null, { bassOn: false }),
          verse: section('Verse', 8, 'I | IV | iii7 vi7 | ii7 V7', dr, { keysStyle: 'pulse', bassStyle: 'syncopated' }),
          chorus: section('Chorus', 8, 'IV | iii7 vi7 | ii7 V7 | I', Object.assign({ tom: '............x.xx', ohat: '......x.......x.' }, dr), { keysStyle: 'pulse', padOn: true, bassStyle: 'octave' }),
          vamp: section('Vamp', 8, 'IV | V | iii7 | vi7', { kick: 'x...x...x...x...', snare: '....x.......x...', clap: '....x.......x...', hat: 'x.xox.xox.xox.xo' }, { keysStyle: 'eighths', padOn: true, bassStyle: 'pulse8' })
        };
        return song({ name: 'My Gospel Song', genre: 'gospel', bpm: 76, key: 8, swing: 0.45, kit: 'acoustic', inst: { keys: 'organ', pad: 'choir', bass: 'electric', melody: 'piano' } },
          s, ['intro', 'verse', 'chorus', 'verse', 'chorus', 'vamp', 'chorus', 'intro']);
      }
    },
    {
      id: 'pop', name: 'Pop', icon: '⭐', desc: 'Four-on-the-floor chorus, pluck synth and lead hook',
      build() {
        const hook = melody(64, [[0, 4, 2], [2, 4, 2], [4, 5, 2], [6, 4, 4], [12, 2, 4], [16, 3, 2], [18, 3, 2], [20, 5, 2], [22, 4, 4], [28, 2, 4],
          [32, 4, 2], [34, 4, 2], [36, 7, 2], [38, 6, 4], [44, 4, 4], [48, 6, 4], [52, 5, 4], [56, 4, 8]]);
        const s = {
          intro: section('Intro', 4, 'vi | IV | I | V', null, { keysStyle: 'arp', padOn: true, bassOn: false }),
          verse: section('Verse', 8, 'vi | IV | I | V', { kick: 'x.....x.x.......', clap: '....x.......x...', hat: 'x.x.x.x.x.x.x.x.' }, { keysStyle: 'stabs', bassStyle: 'pulse8' }),
          pre: section('Pre-Chorus', 4, 'IV | V | vi | V', { kick: 'x...x...x...x...', snare: 'x...x...x.x.xxxx' }, { keysStyle: 'pulse', padOn: true, bassStyle: 'pulse8' }),
          chorus: section('Chorus', 8, 'vi | IV | I | V', { kick: 'x...x...x...x...', clap: '....x.......x...', hat: 'x.x.x.x.x.x.x.x.', ohat: '..............x.' }, { keysStyle: 'pulse', padOn: true, bassStyle: 'octave', melodyOn: true, melody: hook })
        };
        return song({ name: 'My Pop Song', genre: 'pop', bpm: 112, key: 0, kit: 'electronic', inst: { keys: 'pluck', pad: 'pad', bass: 'synth', melody: 'lead' } },
          s, ['intro', 'verse', 'pre', 'chorus', 'verse', 'pre', 'chorus', 'chorus', 'intro']);
      }
    },
    {
      id: 'afro', name: 'Afrobeats', icon: '🌍', desc: 'Bouncy shaker groove, off-beat keys, syncopated bass',
      build() {
        const dr = { kick: 'x.....x...x.....', clap: '....x.......x...', perc: 'xoxoxoxoxoxoxoxo', tom: '...x..x....x..x.', hat: '..x...x...x...x.' };
        const s = {
          intro: section('Intro', 4, 'IV | V | iii | vi', null, { keysStyle: 'stabs', padOn: true, bassOn: false }),
          verse: section('Verse', 8, 'IV | V | iii | vi', dr, { keysStyle: 'stabs', bassStyle: 'syncopated' }),
          chorus: section('Chorus', 8, 'IV | V | iii | vi', dr, { keysStyle: 'stabs', padOn: true, bassStyle: 'syncopated' })
        };
        return song({ name: 'My Afrobeats Song', genre: 'afro', bpm: 104, key: 7, swing: 0.2, kit: 'electronic', inst: { keys: 'epiano', pad: 'pad', bass: 'synth', melody: 'pluck' } },
          s, ['intro', 'verse', 'chorus', 'verse', 'chorus', 'intro']);
      }
    },
    {
      id: 'rnb', name: 'R&B / Soul', icon: '💜', desc: 'Smooth maj7 chords, Rhodes, laid-back swing',
      build() {
        const prog = 'IVmaj7 | iii7 | vi9 | ii7 V7';
        const dr = { kick: 'x......x..x.....', snare: '....x.......x...', hat: 'x.x.x.x.x.x.x2x.', perc: '.......x......x.' };
        const s = {
          intro: section('Intro', 4, prog, null, { padOn: true, bassOn: false }),
          verse: section('Verse', 8, prog, dr, { keysStyle: 'block', bassStyle: 'root' }),
          chorus: section('Chorus', 8, prog, dr, { keysStyle: 'block', padOn: true, bassStyle: '808' })
        };
        return song({ name: 'My R&B Song', genre: 'rnb', bpm: 80, key: 3, swing: 0.35, kit: '808', inst: { keys: 'epiano', pad: 'pad', bass: 'synth', melody: 'bell' } },
          s, ['intro', 'verse', 'chorus', 'verse', 'chorus', 'intro']);
      }
    },
    {
      id: 'empty', name: 'Start from scratch', icon: '✏️', desc: 'One empty 4-bar section — build everything yourself',
      build() {
        const s = { a: section('Section 1', 4, 'I | IV | V | I', {}, { drumsOn: true }) };
        return song({ name: 'Untitled Song', genre: 'empty', bpm: 100, key: 0, kit: 'acoustic', inst: {} }, s, ['a']);
      }
    }
  ];

  const GROOVES = [
    ['Worship ballad', { kick: 'x.......x.......', perc: '....x.......x...', hat: 'x.x.x.x.x.x.x.x.' }],
    ['Worship drive', { kick: 'x.....x.x.......', snare: '....x.......x...', hat: 'x.x.x.x.x.x.x.x.', ohat: '..............x.' }],
    ['Four on the floor', { kick: 'x...x...x...x...', clap: '....x.......x...', hat: '..x...x...x...x.' }],
    ['Trap', { kick: 'x......x..x.....', snare: '........x.......', clap: '........x.......', hat: 'x.x.x.x2x.x.x3x.' }],
    ['Drill', { kick: 'x.........x..x..', snare: '........x.....x.', hat: 'x..x..x.x..x..x.', perc: '...x.......x....' }],
    ['Boom bap', { kick: 'x.....x...x..x..', snare: '....x.......x...', hat: 'x.x.x.x.x.x.x.xo' }],
    ['Lo-fi', { kick: 'x......x..x.....', snare: '....x.......x...', hat: 'x.xox.xox.xox.xo' }],
    ['Jazz swing ride', { ride: 'x...x.x.x...x.x.', hat: '....x.......x...', kick: 'x.......x.......', snare: '......o.......o.' }],
    ['Gospel shuffle', { kick: 'x......x.x......', snare: '....x.......x...', hat: 'x.xox.xox.xox.xo', tom: '............x.xx' }],
    ['Afrobeats', { kick: 'x.....x...x.....', clap: '....x.......x...', perc: 'xoxoxoxoxoxoxoxo', tom: '...x..x....x..x.', hat: '..x...x...x...x.' }],
    ['Dembow / Reggaeton', { kick: 'x...x...x...x...', snare: '...x..x....x..x.', hat: 'x.x.x.x.x.x.x.x.' }],
    ['Rock', { kick: 'x.....x.x.......', snare: '....x.......x...', hat: 'x.x.x.x.x.x.x.x.' }],
    ['Half-time', { kick: 'x.........x.....', snare: '........x.......', hat: 'x.x.x.x.x.x.x.x.' }],
    ['Build-up (snare roll)', { kick: 'x...x...x...x...', snare: 'x...x...x.x.xxxx' }],
    ['Tom fill', { kick: 'x...............', tom: '........x.x.xxxx', snare: '....x.x.........' }]
  ];

  const PROGRESSIONS = [
    ['Pop / Worship  I–V–vi–IV', 'I | V | vi | IV'],
    ['Emotional  vi–IV–I–V', 'vi | IV | I | V'],
    ['Worship lift  IV–I–V–vi', 'IV | I | V | vi'],
    ['Classic  I–IV–V–I', 'I | IV | V | I'],
    ['Doo-wop  I–vi–IV–V', 'I | vi | IV | V'],
    ['Jazz ii–V–I', 'ii7 | V7 | Imaj7 | Imaj7'],
    ['Jazz turnaround', 'Imaj7 | VI7 | ii7 | V7'],
    ['Trap dark  i–bVI–bIII–bVII', 'i | bVI | bIII | bVII'],
    ['Minor  i–iv–v–i', 'i | iv | v | i'],
    ['Andalusian  i–bVII–bVI–V', 'i | bVII | bVI | V'],
    ['R&B smooth', 'IVmaj7 | iii7 | vi9 | ii7 V7'],
    ['Gospel walk', 'I | IV | iii7 vi7 | ii7 V7'],
    ['Neo-soul', 'ii9 | V7 | Imaj7 | vi7'],
    ['Pachelbel / Classical', 'I | V | vi | iii | IV | I | IV | V'],
    ['Afro groove', 'IV | V | iii | vi'],
    ['12-bar blues', 'I7 | IV7 | I7 | I7 | IV7 | IV7 | I7 | I7 | V7 | IV7 | I7 | V7']
  ];

  function build(id) {
    const g = GENRES.find(x => x.id === id) || GENRES[0];
    return g.build();
  }

  return { GENRES, GROOVES, PROGRESSIONS, MEL_ROWS, uid, pat, drums, emptyMelody, section, channel, build };
})();
