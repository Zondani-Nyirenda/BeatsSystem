'use strict';
/*
 * Synth — every sound in Beats Studio is generated in code with the Web Audio API
 * (no sample files needed). Works with AudioContext (live) and OfflineAudioContext (export).
 */
const Synth = (() => {
  const DRUMS = ['kick', 'snare', 'clap', 'hat', 'ohat', 'ride', 'tom', 'perc'];
  const DRUM_NAMES = { kick: 'Kick', snare: 'Snare', clap: 'Clap', hat: 'Hi-hat', ohat: 'Open hat', ride: 'Ride', tom: 'Tom', perc: 'Perc' };
  const mtof = m => 440 * Math.pow(2, (m - 69) / 12);

  // ---------- low-level helpers ----------
  const cache = new WeakMap();
  function store(ctx) { let s = cache.get(ctx); if (!s) { s = { curves: {} }; cache.set(ctx, s); } return s; }

  function noiseBuffer(ctx) {
    const s = store(ctx);
    if (!s.noise) {
      const len = ctx.sampleRate * 2;
      const b = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = b.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      s.noise = b;
    }
    return s.noise;
  }
  function noise(ctx, t, dur) {
    const n = ctx.createBufferSource();
    n.buffer = noiseBuffer(ctx);
    n.loop = true;
    n.start(t, Math.random() * 1.5);
    n.stop(t + dur);
    n.onended = release;
    return n;
  }
  function osc(ctx, type, freq, t, dur) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    o.start(t);
    o.stop(t + dur);
    o.onended = release;
    return o;
  }
  // Disconnect finished sources so the browser can drop the whole voice from the audio graph
  function release() { this.disconnect(); }
  function gain(ctx, v = 1) { const g = ctx.createGain(); g.gain.value = v; return g; }
  function filter(ctx, type, freq, Q = 0.7) {
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = Q;
    return f;
  }
  function shaper(ctx, amount) {
    const s = store(ctx);
    const key = amount.toFixed(2);
    if (!s.curves[key]) {
      const n = 2048, c = new Float32Array(n), k = 1 + amount * 12;
      for (let i = 0; i < n; i++) { const x = i / (n - 1) * 2 - 1; c[i] = Math.tanh(k * x) / Math.tanh(k); }
      s.curves[key] = c;
    }
    const w = ctx.createWaveShaper();
    w.curve = s.curves[key];
    w.oversample = '2x';
    return w;
  }
  // Percussive envelope (exponential attack/decay)
  function perc(g, t, peak, attack, decay) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }
  // Sustained ADSR envelope; returns the time at which the voice can be stopped
  function adsr(g, t, dur, peak, a, d, s, r) {
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + a);
    g.gain.setTargetAtTime(peak * s, t + a, Math.max(d, 0.001) / 3);
    const off = Math.max(t + dur, t + a);
    g.gain.setTargetAtTime(0, off, Math.max(r, 0.005) / 4);
    return off + r * 1.6 + 0.05;
  }

  // ---------- drum kits ----------
  const KITS = {
    '808': {
      name: '808 Trap',
      kick: { f0: 120, f1: 40, decay: 1.1, click: 0.15, drive: 0.35, lvl: 1.1 },
      snare: { tone: 190, toneDecay: 0.09, noiseDecay: 0.2, hp: 1800, lp: 12000, lvl: 0.75 },
      hat: { decay: 0.045, lvl: 0.32 }, ohat: { decay: 0.32, lvl: 0.28 }, ride: { decay: 1.0, lvl: 0.16 },
      tom: { f0: 180, f1: 70, decay: 0.5, lvl: 0.7 }, clap: { lvl: 0.8 }, perc: 'rim'
    },
    acoustic: {
      name: 'Acoustic Kit',
      kick: { f0: 130, f1: 50, decay: 0.38, click: 0.5, drive: 0.1, lvl: 1.0 },
      snare: { tone: 185, toneDecay: 0.12, noiseDecay: 0.24, hp: 1100, lp: 9000, lvl: 0.9 },
      hat: { decay: 0.06, lvl: 0.28 }, ohat: { decay: 0.45, lvl: 0.24 }, ride: { decay: 1.6, lvl: 0.2 },
      tom: { f0: 150, f1: 95, decay: 0.4, lvl: 0.75 }, clap: { lvl: 0.6 }, perc: 'shaker'
    },
    jazz: {
      name: 'Jazz Brushes',
      kick: { f0: 95, f1: 55, decay: 0.3, click: 0.15, drive: 0, lvl: 0.7 },
      snare: { brush: true, tone: 200, toneDecay: 0.06, noiseDecay: 0.32, hp: 500, lp: 5000, lvl: 0.55 },
      hat: { decay: 0.05, lvl: 0.2 }, ohat: { decay: 0.3, lvl: 0.18 }, ride: { decay: 2.2, lvl: 0.26 },
      tom: { f0: 140, f1: 100, decay: 0.35, lvl: 0.6 }, clap: { lvl: 0.4 }, perc: 'rim'
    },
    electronic: {
      name: 'Electronic',
      kick: { f0: 170, f1: 45, decay: 0.55, click: 0.7, drive: 0.25, lvl: 1.0 },
      snare: { tone: 230, toneDecay: 0.07, noiseDecay: 0.16, hp: 2200, lp: 14000, lvl: 0.8 },
      hat: { decay: 0.035, lvl: 0.3 }, ohat: { decay: 0.25, lvl: 0.26 }, ride: { decay: 0.9, lvl: 0.18 },
      tom: { f0: 200, f1: 80, decay: 0.3, lvl: 0.6 }, clap: { lvl: 0.85 }, perc: 'shaker'
    },
    lofi: {
      name: 'Lo-fi Dusty',
      kick: { f0: 110, f1: 48, decay: 0.42, click: 0.25, drive: 0.3, lvl: 1.0 },
      snare: { tone: 180, toneDecay: 0.1, noiseDecay: 0.2, hp: 900, lp: 4500, lvl: 0.8 },
      hat: { decay: 0.05, lvl: 0.24, dark: true }, ohat: { decay: 0.3, lvl: 0.2, dark: true }, ride: { decay: 1.2, lvl: 0.16, dark: true },
      tom: { f0: 140, f1: 85, decay: 0.35, lvl: 0.65 }, clap: { lvl: 0.6 }, perc: 'rim'
    }
  };

  function kick(ctx, out, t, v, k) {
    const o = osc(ctx, 'sine', k.f0, t, k.decay + 0.1);
    o.frequency.exponentialRampToValueAtTime(k.f1, t + 0.06 + k.decay * 0.08);
    const g = gain(ctx, 0);
    perc(g, t, v * k.lvl, 0.002, k.decay);
    let node = o;
    if (k.drive > 0) { const sh = shaper(ctx, k.drive); o.connect(sh); node = sh; }
    node.connect(g).connect(out);
    if (k.click > 0) {
      const n = noise(ctx, t, 0.03);
      const cg = gain(ctx, 0);
      perc(cg, t, v * k.click * 0.5, 0.001, 0.012);
      n.connect(filter(ctx, 'highpass', 2500)).connect(cg).connect(out);
    }
  }

  function snare(ctx, out, t, v, k) {
    const n = noise(ctx, t, k.noiseDecay + 0.05);
    const g = gain(ctx, 0);
    if (k.brush) {
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(v * k.lvl * 0.8, t + 0.025);
      g.gain.exponentialRampToValueAtTime(0.0001, t + k.noiseDecay);
    } else perc(g, t, v * k.lvl, 0.001, k.noiseDecay);
    n.connect(filter(ctx, 'highpass', k.hp)).connect(filter(ctx, 'lowpass', k.lp)).connect(g).connect(out);
    const o = osc(ctx, 'triangle', k.tone, t, k.toneDecay + 0.05);
    o.frequency.exponentialRampToValueAtTime(k.tone * 0.7, t + k.toneDecay);
    const og = gain(ctx, 0);
    perc(og, t, v * k.lvl * (k.brush ? 0.2 : 0.7), 0.001, k.toneDecay);
    o.connect(og).connect(out);
  }

  const METAL_F = [205.3, 304.4, 369.6, 522.7, 540, 800];
  function metal(ctx, out, t, v, decay, lvl, bp, hpF, dark) {
    const g = gain(ctx, 0);
    perc(g, t, v * lvl, 0.001, decay);
    const mix = gain(ctx, 0.2);
    METAL_F.forEach(f => osc(ctx, 'square', f, t, decay + 0.05).connect(mix));
    let last = mix.connect(filter(ctx, 'bandpass', bp, 0.8)).connect(filter(ctx, 'highpass', hpF));
    if (dark) last = last.connect(filter(ctx, 'lowpass', 6000));
    last.connect(g).connect(out);
    const n = noise(ctx, t, decay + 0.05);
    const ng = gain(ctx, 0);
    perc(ng, t, v * lvl * 0.5, 0.001, decay * 0.8);
    let nl = n.connect(filter(ctx, 'highpass', hpF + 1000));
    if (dark) nl = nl.connect(filter(ctx, 'lowpass', 7000));
    nl.connect(ng).connect(out);
  }

  function clap(ctx, out, t, v, k) {
    const n = noise(ctx, t, 0.3);
    const g = gain(ctx, 0);
    const p = v * k.lvl;
    g.gain.setValueAtTime(0.0001, t);
    [0, 0.011, 0.022].forEach(d => {
      g.gain.setValueAtTime(p, t + d);
      g.gain.exponentialRampToValueAtTime(p * 0.15, t + d + 0.009);
    });
    g.gain.setValueAtTime(p * 0.7, t + 0.031);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.031 + 0.18);
    n.connect(filter(ctx, 'highpass', 600)).connect(filter(ctx, 'bandpass', 1200, 1.2)).connect(g).connect(out);
  }

  function tom(ctx, out, t, v, k) {
    const o = osc(ctx, 'sine', k.f0, t, k.decay + 0.05);
    o.frequency.exponentialRampToValueAtTime(k.f1, t + k.decay);
    const g = gain(ctx, 0);
    perc(g, t, v * k.lvl, 0.002, k.decay);
    o.connect(g).connect(out);
  }

  function percussion(ctx, out, t, v, type) {
    if (type === 'shaker') {
      const n = noise(ctx, t, 0.12);
      const g = gain(ctx, 0);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(v * 0.22, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.085);
      n.connect(filter(ctx, 'highpass', 6000)).connect(g).connect(out);
    } else {
      const o = osc(ctx, 'triangle', 1700, t, 0.06);
      const g = gain(ctx, 0);
      perc(g, t, v * 0.35, 0.001, 0.035);
      o.connect(g).connect(out);
      const n = noise(ctx, t, 0.03);
      const ng = gain(ctx, 0);
      perc(ng, t, v * 0.2, 0.001, 0.02);
      n.connect(filter(ctx, 'bandpass', 3000, 2)).connect(ng).connect(out);
    }
  }

  function drum(ctx, out, name, t, v, kitName) {
    const k = KITS[kitName] || KITS.acoustic;
    switch (name) {
      case 'kick': return kick(ctx, out, t, v, k.kick);
      case 'snare': return snare(ctx, out, t, v, k.snare);
      case 'clap': return clap(ctx, out, t, v, k.clap);
      case 'hat': return metal(ctx, out, t, v, k.hat.decay, k.hat.lvl, 10000, 7000, k.hat.dark);
      case 'ohat': return metal(ctx, out, t, v, k.ohat.decay, k.ohat.lvl, 10000, 7000, k.ohat.dark);
      case 'ride': return metal(ctx, out, t, v, k.ride.decay, k.ride.lvl, 6500, 4000, k.ride.dark);
      case 'tom': return tom(ctx, out, t, v, k.tom);
      case 'perc': return percussion(ctx, out, t, v, k.perc);
    }
  }

  // ---------- melodic instruments ----------
  function piano(ctx, out, m, t, dur, v) {
    const f = mtof(m);
    const decay = 2.8 * Math.pow(0.5, (m - 60) / 24);
    const end = t + Math.min(dur + 0.5, decay * 1.6 + 0.1);
    const g = gain(ctx, 0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(v * 0.3, t + 0.004);
    g.gain.setTargetAtTime(0, t + 0.004, decay / 4);
    g.gain.setTargetAtTime(0, t + dur, 0.08);
    const lp = filter(ctx, 'lowpass', Math.min(f * 8, 10000));
    lp.frequency.setTargetAtTime(Math.min(f * 3, 6000), t, 0.3);
    [[1, 1, 'triangle'], [2, 0.4, 'sine'], [3, 0.15, 'sine'], [4, 0.06, 'sine']].forEach(([hm, a, ty]) => {
      osc(ctx, ty, f * hm * (1 + (hm - 1) * 0.0008), t, end - t).connect(gain(ctx, a)).connect(lp);
    });
    lp.connect(g).connect(out);
  }

  function epiano(ctx, out, m, t, dur, v) {
    const f = mtof(m);
    const end = t + dur + 0.7;
    const car = osc(ctx, 'sine', f, t, end - t);
    const mod = osc(ctx, 'sine', f, t, end - t);
    const mg = gain(ctx, 0);
    mg.gain.setValueAtTime(f * 2.2 * v, t);
    mg.gain.setTargetAtTime(f * 0.3, t, 0.25);
    mod.connect(mg).connect(car.frequency);
    const g = gain(ctx, 0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(v * 0.28, t + 0.005);
    g.gain.setTargetAtTime(v * 0.11, t + 0.005, 0.6);
    g.gain.setTargetAtTime(0, t + dur, 0.12);
    car.connect(g).connect(out);
  }

  function organ(ctx, out, m, t, dur, v) {
    const f = mtof(m);
    const g = gain(ctx, 0);
    const end = adsr(g, t, dur, v * 0.12, 0.01, 0.1, 0.95, 0.08);
    const trem = gain(ctx, 1);
    const lfo = osc(ctx, 'sine', 5.8, t, end - t);
    lfo.connect(gain(ctx, 0.12)).connect(trem.gain);
    [[1, 1], [2, 0.7], [3, 0.45], [4, 0.3], [6, 0.15], [8, 0.1]].forEach(([hm, a]) =>
      osc(ctx, 'sine', f * hm, t, end - t).connect(gain(ctx, a)).connect(g));
    g.connect(trem).connect(out);
  }

  function strings(ctx, out, m, t, dur, v, o = {}) {
    const f = mtof(m);
    const g = gain(ctx, 0);
    const end = adsr(g, t, dur, v * 0.085, o.a ?? 0.3, 0.4, 0.85, o.r ?? 0.7);
    const lp = filter(ctx, 'lowpass', o.cut ?? Math.min(f * 6, 5000), 0.6);
    const vg = gain(ctx, 6);
    osc(ctx, 'sine', 5.2, t, end - t).connect(vg);
    [-9, 0, 9].forEach(d => {
      const s = osc(ctx, 'sawtooth', f, t, end - t);
      s.detune.value = d;
      vg.connect(s.detune);
      s.connect(lp);
    });
    lp.connect(g).connect(out);
  }

  function pad(ctx, out, m, t, dur, v) {
    const f = mtof(m);
    const g = gain(ctx, 0);
    const end = adsr(g, t, dur, v * 0.075, 0.9, 1, 0.9, 1.6);
    const lp = filter(ctx, 'lowpass', 1100, 1);
    osc(ctx, 'sine', 0.25, t, end - t).connect(gain(ctx, 400)).connect(lp.frequency);
    [['sawtooth', -12, 1], ['sawtooth', 12, 1], ['triangle', 0, 1.2]].forEach(([ty, d, a]) => {
      const s = osc(ctx, ty, f, t, end - t);
      s.detune.value = d;
      s.connect(gain(ctx, a)).connect(lp);
    });
    lp.connect(g).connect(out);
  }

  function choir(ctx, out, m, t, dur, v) {
    const f = mtof(m);
    const g = gain(ctx, 0);
    const end = adsr(g, t, dur, v * 0.55, 0.35, 0.5, 0.9, 0.8);
    const src = gain(ctx, 1);
    const vg = gain(ctx, 10);
    osc(ctx, 'sine', 5, t, end - t).connect(vg);
    [-10, 0, 10].forEach(d => {
      const s = osc(ctx, 'sawtooth', f, t, end - t);
      s.detune.value = d;
      vg.connect(s.detune);
      s.connect(src);
    });
    [[730, 1], [1090, 0.5], [2440, 0.25]].forEach(([ff, a]) =>
      src.connect(filter(ctx, 'bandpass', ff, 10)).connect(gain(ctx, a)).connect(g));
    g.connect(out);
  }

  function pluck(ctx, out, m, t, dur, v) {
    const f = mtof(m);
    const len = Math.min(dur, 1.2) + 0.4;
    const lp = filter(ctx, 'lowpass', Math.min(f * 10, 12000), 2);
    lp.frequency.setTargetAtTime(Math.max(f * 1.2, 250), t, 0.08);
    const g = gain(ctx, 0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(v * 0.15, t + 0.003);
    g.gain.setTargetAtTime(0, t + 0.003, 0.25);
    g.gain.setTargetAtTime(0, t + Math.min(dur, 1.2), 0.05);
    osc(ctx, 'sawtooth', f, t, len).connect(lp);
    osc(ctx, 'square', f * 1.005, t, len).connect(gain(ctx, 0.5)).connect(lp);
    lp.connect(g).connect(out);
  }

  function bell(ctx, out, m, t, dur, v) {
    const f = mtof(m);
    const d = Math.max(dur, 0.3);
    const len = d + 1.5;
    const g = gain(ctx, 0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(v * 0.2, t + 0.002);
    g.gain.setTargetAtTime(0, t + 0.002, 0.5);
    g.gain.setTargetAtTime(0, t + d, 0.25);
    const car = osc(ctx, 'sine', f, t, len);
    const mod = osc(ctx, 'sine', f * 3.5, t, len);
    const mg = gain(ctx, 0);
    mg.gain.setValueAtTime(f * 1.8, t);
    mg.gain.setTargetAtTime(f * 0.2, t, 0.3);
    mod.connect(mg).connect(car.frequency);
    car.connect(g).connect(out);
    const g2 = gain(ctx, 0);
    perc(g2, t, v * 0.05, 0.002, 0.6);
    osc(ctx, 'sine', f * 2, t, len).connect(g2).connect(out);
  }

  function lead(ctx, out, m, t, dur, v) {
    const f = mtof(m);
    const g = gain(ctx, 0);
    const end = adsr(g, t, dur, v * 0.09, 0.01, 0.2, 0.75, 0.12);
    const lp = filter(ctx, 'lowpass', Math.min(f * 6, 7000), 1.5);
    const vg = gain(ctx, 0);
    vg.gain.setValueAtTime(0, t);
    vg.gain.linearRampToValueAtTime(12, t + 0.35);
    osc(ctx, 'sine', 5.5, t, end - t).connect(vg);
    ['square', 'sawtooth'].forEach((ty, i) => {
      const s = osc(ctx, ty, f, t, end - t);
      s.detune.value = i ? 7 : -7;
      vg.connect(s.detune);
      s.connect(lp);
    });
    lp.connect(g).connect(out);
  }

  function brass(ctx, out, m, t, dur, v) {
    const f = mtof(m);
    const g = gain(ctx, 0);
    const end = adsr(g, t, dur, v * 0.09, 0.05, 0.2, 0.8, 0.15);
    const lp = filter(ctx, 'lowpass', f * 1.5, 1);
    lp.frequency.setValueAtTime(f * 1.5, t);
    lp.frequency.linearRampToValueAtTime(Math.min(f * 6, 6000), t + 0.08);
    lp.frequency.setTargetAtTime(Math.min(f * 3.5, 4000), t + 0.1, 0.3);
    [-5, 5].forEach(d => { const s = osc(ctx, 'sawtooth', f, t, end - t); s.detune.value = d; s.connect(lp); });
    lp.connect(g).connect(out);
  }

  function flute(ctx, out, m, t, dur, v) {
    const f = mtof(m);
    const g = gain(ctx, 0);
    const end = adsr(g, t, dur, v * 0.2, 0.06, 0.2, 0.85, 0.15);
    const vg = gain(ctx, 0);
    vg.gain.setValueAtTime(0, t);
    vg.gain.linearRampToValueAtTime(9, t + 0.4);
    osc(ctx, 'sine', 5, t, end - t).connect(vg);
    const s = osc(ctx, 'sine', f, t, end - t);
    vg.connect(s.detune);
    s.connect(g);
    osc(ctx, 'triangle', f * 2, t, end - t).connect(gain(ctx, 0.08)).connect(g);
    noise(ctx, t, end - t).connect(filter(ctx, 'bandpass', f * 2, 2)).connect(gain(ctx, 0.15)).connect(g);
    g.connect(out);
  }

  // ---------- bass instruments ----------
  function b808(ctx, out, m, t, dur, v) {
    const f = mtof(m);
    const o = osc(ctx, 'sine', f * 1.6, t, dur + 0.3);
    o.frequency.exponentialRampToValueAtTime(f, t + 0.04);
    const g = gain(ctx, 0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(v * 0.55, t + 0.004);
    g.gain.setTargetAtTime(v * 0.35, t + 0.004, 0.4);
    g.gain.setTargetAtTime(0, t + dur, 0.06);
    o.connect(shaper(ctx, 0.5)).connect(g).connect(out);
  }

  function sbass(ctx, out, m, t, dur, v) {
    const f = mtof(m);
    const g = gain(ctx, 0);
    const end = adsr(g, t, dur, v * 0.22, 0.005, 0.25, 0.7, 0.06);
    const lp = filter(ctx, 'lowpass', Math.min(f * 12, 4000), 4);
    lp.frequency.setTargetAtTime(f * 3, t, 0.08);
    osc(ctx, 'sawtooth', f, t, end - t).connect(lp);
    osc(ctx, 'square', f / 2, t, end - t).connect(gain(ctx, 0.5)).connect(lp);
    lp.connect(g).connect(out);
  }

  function upright(ctx, out, m, t, dur, v) {
    const f = mtof(m);
    const g = gain(ctx, 0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(v * 0.5, t + 0.008);
    g.gain.setTargetAtTime(v * 0.15, t + 0.008, 0.25);
    g.gain.setTargetAtTime(0, t + dur, 0.05);
    const lp = filter(ctx, 'lowpass', f * 5, 0.8);
    lp.frequency.setTargetAtTime(f * 2, t, 0.2);
    osc(ctx, 'triangle', f, t, dur + 0.3).connect(lp);
    osc(ctx, 'sine', f * 2, t, dur + 0.3).connect(gain(ctx, 0.3)).connect(lp);
    lp.connect(g).connect(out);
  }

  function ebass(ctx, out, m, t, dur, v) {
    const f = mtof(m);
    const g = gain(ctx, 0);
    const end = adsr(g, t, dur, v * 0.3, 0.005, 0.3, 0.6, 0.07);
    const lp = filter(ctx, 'lowpass', Math.min(f * 8, 2500), 1.5);
    osc(ctx, 'square', f, t, end - t).connect(gain(ctx, 0.35)).connect(lp);
    osc(ctx, 'sine', f, t, end - t).connect(lp);
    osc(ctx, 'triangle', f * 2, t, end - t).connect(gain(ctx, 0.2)).connect(lp);
    lp.connect(g).connect(out);
  }

  function cello(ctx, out, m, t, dur, v) { strings(ctx, out, m, t, dur, v * 1.8, { a: 0.12, r: 0.3, cut: 1800 }); }

  const INSTRUMENTS = {
    piano: { name: 'Grand Piano', fn: piano },
    epiano: { name: 'Electric Piano', fn: epiano },
    organ: { name: 'Gospel Organ', fn: organ },
    strings: { name: 'Strings', fn: strings },
    pad: { name: 'Warm Pad', fn: pad },
    choir: { name: 'Choir', fn: choir },
    pluck: { name: 'Pluck Synth', fn: pluck },
    bell: { name: 'Bells', fn: bell },
    lead: { name: 'Synth Lead', fn: lead },
    brass: { name: 'Brass', fn: brass },
    flute: { name: 'Flute', fn: flute },
    '808': { name: '808 Bass', fn: b808, bass: true },
    synth: { name: 'Synth Bass', fn: sbass, bass: true },
    upright: { name: 'Upright Bass', fn: upright, bass: true },
    electric: { name: 'Electric Bass', fn: ebass, bass: true },
    cello: { name: 'Cello', fn: cello, bass: true }
  };

  function note(ctx, out, inst, m, t, dur, v) {
    (INSTRUMENTS[inst] || INSTRUMENTS.piano).fn(ctx, out, m, t, Math.max(dur, 0.05), v);
  }

  // ---------- sample cache ----------
  // Each distinct sound (drum hit, or instrument+pitch+length) is synthesized once into an
  // AudioBuffer, then played back as a sample. This is many times cheaper than running the
  // full synth voice every time, so playback and export stay smooth even on slow computers.
  const REF_VEL = 0.8;
  const samples = new Map();
  const pending = new Map();
  let queue = Promise.resolve();
  const bucket = d => d < 1 ? Math.ceil(d * 20) / 20 : Math.ceil(d * 4) / 4;
  const sampleKey = ev => ev.kind === 'drum' ? `d|${ev.kit}|${ev.name}` : `n|${ev.inst}|${ev.m}|${bucket(ev.dur)}`;

  function trimBuffer(buf) {
    const d = buf.getChannelData(0);
    let end = d.length;
    while (end > 1 && Math.abs(d[end - 1]) < 1e-4) end--;
    end = Math.min(d.length, end + 64);
    if (end >= d.length) return buf;
    const nb = new AudioBuffer({ length: end, numberOfChannels: 1, sampleRate: buf.sampleRate });
    nb.copyToChannel(d.subarray(0, end), 0);
    return nb;
  }
  function renderSample(ev, sr) {
    const k = sampleKey(ev) + '|' + sr;
    if (samples.has(k)) return Promise.resolve(samples.get(k));
    if (pending.has(k)) return pending.get(k);
    const len = ev.kind === 'drum' ? 2.6 : bucket(ev.dur) + 3;
    const pr = queue = queue.then(async () => {
      const ctx = new OfflineAudioContext(1, Math.ceil(len * sr), sr);
      if (ev.kind === 'drum') drum(ctx, ctx.destination, ev.name, 0, REF_VEL, ev.kit);
      else note(ctx, ctx.destination, ev.inst, ev.m, 0, bucket(ev.dur), REF_VEL);
      const buf = trimBuffer(await ctx.startRendering());
      if (samples.size > 3000) samples.delete(samples.keys().next().value);
      samples.set(k, buf);
      pending.delete(k);
      return buf;
    }).catch(e => { pending.delete(k); console.warn('sample render failed', e); });
    pending.set(k, pr);
    return pr;
  }
  function warm(events, sr) { return Promise.all(events.map(e => renderSample(e, sr))); }
  function isReady(events, sr) { return events.every(e => samples.has(sampleKey(e) + '|' + sr)); }

  // Play a sound event: {kind:'drum', kit, name, vel} or {kind:'note', inst, m, dur, vel}
  function play(ctx, out, ev, t) {
    const k = sampleKey(ev) + '|' + ctx.sampleRate;
    const buf = samples.get(k);
    if (buf) {
      const s = ctx.createBufferSource();
      s.buffer = buf;
      const g = gain(ctx, ev.vel / REF_VEL);
      s.connect(g).connect(out);
      s.onended = release;
      s.start(t);
      return;
    }
    if (ev.kind === 'drum') drum(ctx, out, ev.name, t, ev.vel, ev.kit);
    else note(ctx, out, ev.inst, ev.m, t, ev.dur, ev.vel);
    if (!pending.has(k)) renderSample(ev, ctx.sampleRate);
  }

  function click(ctx, out, t, accent) {
    const o = osc(ctx, 'sine', accent ? 1600 : 1100, t, 0.06);
    const g = gain(ctx, 0);
    perc(g, t, accent ? 0.5 : 0.3, 0.001, 0.04);
    o.connect(g).connect(out);
  }

  return { DRUMS, DRUM_NAMES, KITS, INSTRUMENTS, drum, note, click, mtof, play, warm, isReady };
})();
