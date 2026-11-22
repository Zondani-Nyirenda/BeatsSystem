'use strict';
/*
 * Engine — mixer, step scheduler, live playback, offline rendering (export) and WAV encoding.
 */
const Engine = (() => {
  const BEAT_CHANNELS = ['drums', 'bass', 'keys', 'pad', 'melody'];
  const stepDur = p => 60 / p.bpm / 4;
  const barDur = p => 60 / p.bpm * 4;
  const fromDB = d => Math.pow(10, d / 20);

  // ---------- song structure ----------
  function songMap(p) {
    const items = [];
    let s = 0;
    p.arrangement.forEach((id, index) => {
      const sec = p.sections.find(x => x.id === id);
      if (!sec) return;
      const steps = sec.bars * 16;
      items.push({ sec, start: s, steps, index });
      s += steps;
    });
    return { items, total: s };
  }
  function locate(map, n) {
    for (const it of map.items) if (n >= it.start && n < it.start + it.steps) return it;
    return null;
  }
  function songLength(p) {
    let len = songMap(p).total * stepDur(p);
    p.tracks.forEach(t => t.clips.forEach(c => { len = Math.max(len, c.start + c.duration); }));
    return len;
  }
  function swingOffset(p, st, sd) {
    if (!p.swing) return 0;
    if (p.swingGrid === '8') return st % 4 === 2 ? p.swing * 0.667 * sd : 0;
    return st % 2 === 1 ? p.swing * 0.5 * sd : 0;
  }

  // ---------- accompaniment styles ----------
  const KEY_STYLES = {
    block: (s, st, L, n) => s === 0 ? [{ notes: n, len: L * 0.98, vel: 0.6 }] : [],
    pulse: (s, st, L, n) => st % 4 === 0 ? [{ notes: n, len: 3.4, vel: st % 8 === 0 ? 0.65 : 0.5 }] : [],
    eighths: (s, st, L, n) => st % 2 === 0 ? [{ notes: n, len: 1.6, vel: st % 4 === 0 ? 0.6 : 0.45 }] : [],
    stabs: (s, st, L, n) => st % 4 === 2 ? [{ notes: n, len: 1, vel: 0.6 }] : [],
    arp: (s, st, L, n) => {
      if (st % 2) return [];
      const seq = [...n, n[0] + 12];
      return [{ notes: [seq[(s >> 1) % seq.length]], len: 2.2, vel: 0.55 }];
    },
    ballad: (s, st, L, n) => s === 0 ? [{ notes: n, len: L, vel: 0.55 }] : (st % 4 === 0 ? [{ notes: n.slice(1), len: 3.5, vel: 0.28 }] : []),
    comp: (s, st, L, n) => (s === 0 || st === 6) ? [{ notes: n, len: s === 0 ? 2.5 : 1.5, vel: s === 0 ? 0.5 : 0.45 }] : [],
    broken: (s, st, L, n) => {
      if (st % 2) return [];
      const so = [...n].sort((a, b) => a - b);
      const seq = [so[0], so[so.length - 1], so[1], so[so.length - 1]];
      return [{ notes: [seq[(st >> 1) % 4]], len: 2, vel: 0.5 }];
    }
  };

  function bassEvents(sec, p, ch, next, s, st, segLen) {
    const root = Theory.bassRoot(p.key, ch, 33);
    const fifth = root + (ch.iv.includes(7) ? 7 : ch.iv[2] ?? 7);
    switch (sec.bassStyle) {
      case 'root': return s === 0 ? [{ m: root, len: segLen * 0.95, vel: 0.85 }] : [];
      case 'pulse8': return st % 2 === 0 ? [{ m: root, len: 1.7, vel: st % 4 === 0 ? 0.85 : 0.7 }] : [];
      case 'octave': return st % 2 === 0 ? [{ m: st % 4 === 0 ? root : root + 12, len: 1.5, vel: 0.8 }] : [];
      case 'syncopated': {
        const P = { 0: [root, 3], 3: [root, 2], 6: [root, 2], 10: [fifth, 2], 12: [root, 3] };
        return P[st] ? [{ m: P[st][0], len: P[st][1], vel: st === 0 ? 0.9 : 0.75 }] : (s === 0 && st !== 0 ? [{ m: root, len: 2, vel: 0.8 }] : []);
      }
      case 'walking': {
        if (st % 4 !== 0) return [];
        const beats = Math.max(1, Math.round(segLen / 4));
        const b = Math.floor(s / 4);
        const nextRoot = Theory.bassRoot(p.key, next, 33);
        let m;
        if (b === 0) m = root;
        else if (b === beats - 1) m = nextRoot === root ? fifth : nextRoot + (nextRoot > root ? -1 : 1);
        else m = [root, root + ch.iv[1], fifth, root + 12][b % 4];
        return [{ m, len: 3.6, vel: b === 0 ? 0.9 : 0.78 }];
      }
      case '808': {
        const kick = sec.drums.kick;
        if (sec.drumsOn && kick.some(v => v)) {
          if (!kick[st]) return [];
          let l = 1;
          while (st + l < 16 && !kick[st + l] && l < 12) l++;
          return [{ m: root, len: Math.max(l, 2) * 0.95, vel: 0.95 }];
        }
        return s === 0 ? [{ m: root, len: segLen * 0.9, vel: 0.9 }] : [];
      }
      default: return [];
    }
  }

  // Everything the beat plays at one 16th-note step of a section, as a list of
  // { ch: mixer channel, dt: seconds after the step, ev: sound event for Synth.play }.
  function stepEvents(p, sec, sIdx, sd) {
    const evs = [];
    const bar = Math.floor(sIdx / 16), st = sIdx % 16;
    if (sec.drumsOn) {
      for (const k of Synth.DRUMS) {
        const v = sec.drums[k][st];
        if (!v) continue;
        const vel = (v === 0.5 ? 0.4 : 1) * (p.drumVol[k] ?? 0.8) * 1.25;
        if (vel <= 0) continue;
        const r = v >= 2 ? v : 1;
        for (let j = 0; j < r; j++) evs.push({ ch: 'drums', dt: j * sd / r, ev: { kind: 'drum', kit: p.kit, name: k, vel: vel * (j ? 0.75 : 1) } });
      }
    }
    const note = (ch, inst, m, dur, vel) => evs.push({ ch, dt: 0, ev: { kind: 'note', inst, m, dur, vel } });
    const bars = Theory.parseProgression(sec.prog);
    const inBar = bars[bar % bars.length];
    const n = inBar.length;
    const segIdx = Math.floor(st * n / 16);
    const segStart = Math.ceil(segIdx * 16 / n);
    const segLen = Math.ceil((segIdx + 1) * 16 / n) - segStart;
    const s = st - segStart;
    const ch = Theory.parseChord(inBar[segIdx], p.key);
    if (ch) {
      const nextSym = segIdx + 1 < n ? inBar[segIdx + 1] : bars[(bar + 1) % bars.length][0];
      const next = Theory.parseChord(nextSym, p.key) || ch;
      if (sec.keysOn) {
        const style = KEY_STYLES[sec.keysStyle] || KEY_STYLES.block;
        const notes = Theory.voice(p.key, ch, 62);
        for (const e of style(s, st, segLen, notes))
          for (const m of e.notes) note('keys', p.inst.keys, m, e.len * sd, e.vel);
      }
      if (sec.padOn && s === 0) {
        for (const m of Theory.voice(p.key, ch, 58)) note('pad', p.inst.pad, m, segLen * sd, 0.6);
      }
      if (sec.bassOn) {
        for (const e of bassEvents(sec, p, ch, next, s, st, segLen)) note('bass', p.inst.bass, e.m, e.len * sd, e.vel);
      }
    }
    if (sec.melodyOn && sec.melody) {
      const len = sec.melodyLen;
      const ms = sIdx % len;
      for (let r = 0; r < sec.melody.length; r++) {
        if (sec.melody[r][ms] !== 1) continue;
        let l = 1;
        while (ms + l < len && sec.melody[r][ms + l] === 2) l++;
        note('melody', p.inst.melody, Theory.degreeMidi(p.key, p.scale, r), l * sd * 0.95, 0.75);
      }
    }
    return evs;
  }

  // out(id) returns the AudioNode to feed for channel `id`.
  function scheduleStep(ctx, out, p, sec, sIdx, t, sd) {
    for (const e of stepEvents(p, sec, sIdx, sd)) Synth.play(ctx, out(e.ch), e.ev, t + e.dt);
  }

  // Every distinct sound the song (or one section) uses — for pre-rendering samples.
  function collectEvents(p, onlySection) {
    const sd = stepDur(p);
    const seen = new Map();
    for (const sec of p.sections) {
      if (onlySection && sec.id !== onlySection) continue;
      for (let i = 0; i < sec.bars * 16; i++) {
        for (const e of stepEvents(p, sec, i, sd)) {
          const ev = e.ev;
          const k = ev.kind === 'drum' ? ev.kit + ev.name : ev.inst + '|' + ev.m + '|' + ev.dur.toFixed(2);
          if (!seen.has(k)) seen.set(k, ev);
        }
      }
    }
    return [...seen.values()];
  }

  // ---------- audio clips ----------
  function clipEnvelope(clip, x) { // x = seconds from clip start
    let v = 1;
    const fi = clip.fadeIn || 0, fo = clip.fadeOut || 0;
    if (fi > 0 && x < fi) v *= Math.max(0, x / fi);
    if (fo > 0 && x > clip.duration - fo) v *= Math.max(0, (clip.duration - x) / fo);
    return v;
  }
  function scheduleClip(ctx, dest, clip, buf, zero, from) {
    const end = clip.start + clip.duration;
    if (!buf || end <= from) return null;
    const s0 = Math.max(clip.start, from);
    const off = clip.offset + (s0 - clip.start);
    const dur = end - s0;
    if (dur <= 0 || off >= buf.duration) return null;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    const G = clip.gain ?? 1;
    const fi = clip.fadeIn || 0, fo = clip.fadeOut || 0;
    g.gain.setValueAtTime(G * clipEnvelope(clip, s0 - clip.start), zero + s0);
    if (fi > 0 && s0 < clip.start + fi) g.gain.linearRampToValueAtTime(G * clipEnvelope(clip, fi), zero + clip.start + fi);
    if (fo > 0) {
      const fs = Math.max(s0, end - fo, clip.start + fi);
      g.gain.setValueAtTime(G * clipEnvelope(clip, fs - clip.start), zero + fs);
      g.gain.linearRampToValueAtTime(0, zero + end);
    }
    src.connect(g).connect(dest);
    src.start(zero + s0, off, dur);
    return src;
  }

  // ---------- mixer ----------
  function impulse(ctx, seconds = 2.8, decay = 2.6) {
    const len = Math.floor(ctx.sampleRate * seconds);
    const b = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return b;
  }

  class Mixer {
    constructor(ctx, dest, opts = {}) {
      this.ctx = ctx;
      this.offline = typeof OfflineAudioContext !== 'undefined' && ctx instanceof OfflineAudioContext;
      this.masterIn = ctx.createGain();
      this.glue = ctx.createDynamicsCompressor();
      this.glue.knee.value = 6; this.glue.attack.value = 0.02; this.glue.release.value = 0.25;
      this.drive = ctx.createGain();
      this.limiter = ctx.createDynamicsCompressor();
      this.limiter.threshold.value = -1.5; this.limiter.knee.value = 0; this.limiter.ratio.value = 20;
      this.limiter.attack.value = 0.002; this.limiter.release.value = 0.1;
      this.masterVol = ctx.createGain();
      // Final safety soft-clipper: transparent below -2 dB, never exceeds full scale
      this.clipper = ctx.createWaveShaper();
      const n = 4096, curve = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * 4 - 2, a = Math.abs(x);
        curve[i] = Math.sign(x) * (a < 0.8 ? a : 0.8 + 0.19 * Math.tanh((a - 0.8) / 0.19));
      }
      this.clipper.curve = curve;
      // A WaveShaper maps input -1..1 across the curve; the curve covers -2..2, so halve the input first.
      const pre = ctx.createGain();
      pre.gain.value = 0.5;
      this.masterIn.connect(this.glue).connect(this.drive).connect(this.limiter).connect(this.masterVol).connect(pre).connect(this.clipper).connect(dest);
      if (opts.analyser) {
        this.analyser = ctx.createAnalyser();
        this.analyser.fftSize = 1024;
        this.clipper.connect(this.analyser);
      }
      this.reverb = ctx.createConvolver();
      this.reverb.buffer = impulse(ctx);
      this.reverb.connect(this.masterIn);
      this.delay = ctx.createDelay(2);
      this.delayFb = ctx.createGain(); this.delayFb.gain.value = 0.35;
      const dlp = ctx.createBiquadFilter(); dlp.type = 'lowpass'; dlp.frequency.value = 3500;
      this.delay.connect(dlp).connect(this.delayFb).connect(this.delay);
      dlp.connect(this.masterIn);
      this.channels = {};
    }
    // Export-only: a channel containing just the effects this config actually uses (much faster to render)
    leanChannel(id, cfg, muted) {
      const c = this.ctx;
      const input = c.createGain();
      let last = input;
      const add = node => { last.connect(node); last = node; return node; };
      const bq = (type, f, g, q) => { const b = c.createBiquadFilter(); b.type = type; b.frequency.value = f; if (g != null) b.gain.value = g; if (q != null) b.Q.value = q; return add(b); };
      if (cfg.hp) bq('highpass', 100, null, 0.7);
      if (cfg.low) bq('lowshelf', 150, cfg.low);
      if (cfg.mid) bq('peaking', 1800, cfg.mid, 0.8);
      if (cfg.high) bq('highshelf', 7000, cfg.high);
      if (cfg.comp) {
        const k = add(c.createDynamicsCompressor());
        k.threshold.value = -cfg.comp * 35; k.ratio.value = 1 + cfg.comp * 7; k.attack.value = 0.008; k.release.value = 0.15;
      }
      if (cfg.pan) { const pn = add(c.createStereoPanner()); pn.pan.value = cfg.pan; }
      const vol = add(c.createGain());
      vol.gain.value = muted ? 0 : cfg.vol * cfg.vol * 2 * (cfg.comp ? fromDB(cfg.comp * 10) : 1);
      vol.connect(this.masterIn);
      if (cfg.reverb) { const r = c.createGain(); r.gain.value = cfg.reverb; vol.connect(r).connect(this.reverb); }
      if (cfg.delay) { const d = c.createGain(); d.gain.value = cfg.delay; vol.connect(d).connect(this.delay); }
      this.channels[id] = { input };
    }
    channel(id) {
      if (this.channels[id]) return this.channels[id];
      const c = this.ctx;
      const ch = {
        input: c.createGain(),
        hp: c.createBiquadFilter(), low: c.createBiquadFilter(), mid: c.createBiquadFilter(), high: c.createBiquadFilter(),
        comp: c.createDynamicsCompressor(), makeup: c.createGain(), pan: c.createStereoPanner(), vol: c.createGain(),
        rev: c.createGain(), dly: c.createGain()
      };
      ch.hp.type = 'highpass'; ch.hp.frequency.value = 10; ch.hp.Q.value = 0.7;
      ch.low.type = 'lowshelf'; ch.low.frequency.value = 150;
      ch.mid.type = 'peaking'; ch.mid.frequency.value = 1800; ch.mid.Q.value = 0.8;
      ch.high.type = 'highshelf'; ch.high.frequency.value = 7000;
      ch.comp.threshold.value = 0; ch.comp.ratio.value = 1; ch.comp.attack.value = 0.008; ch.comp.release.value = 0.15;
      ch.rev.gain.value = 0; ch.dly.gain.value = 0;
      ch.input.connect(ch.hp).connect(ch.low).connect(ch.mid).connect(ch.high).connect(ch.comp).connect(ch.makeup).connect(ch.pan).connect(ch.vol).connect(this.masterIn);
      ch.vol.connect(ch.rev).connect(this.reverb);
      ch.vol.connect(ch.dly).connect(this.delay);
      this.channels[id] = ch;
      return ch;
    }
    input(id) { return this.channel(id).input; }
    set(param, v) {
      if (this.offline) param.value = v;
      else param.setTargetAtTime(v, this.ctx.currentTime, 0.02);
    }
    applyChannel(id, c, muted) {
      const ch = this.channel(id);
      this.set(ch.vol.gain, muted ? 0 : c.vol * c.vol * 2);
      this.set(ch.pan.pan, c.pan || 0);
      this.set(ch.hp.frequency, c.hp ? 100 : 10);
      this.set(ch.low.gain, c.low || 0);
      this.set(ch.mid.gain, c.mid || 0);
      this.set(ch.high.gain, c.high || 0);
      const a = c.comp || 0;
      this.set(ch.comp.threshold, -a * 35);
      this.set(ch.comp.ratio, 1 + a * 7);
      this.set(ch.makeup.gain, fromDB(a * 10));
      this.set(ch.rev.gain, c.reverb || 0);
      this.set(ch.dly.gain, c.delay || 0);
    }
    applyMaster(m, bpm) {
      this.set(this.glue.ratio, m.glue ? 2.5 : 1);
      this.set(this.glue.threshold, m.glue ? -14 : 0);
      this.set(this.drive.gain, fromDB(m.loud || 0));
      this.set(this.masterVol.gain, m.vol);
      this.set(this.delay.delayTime, Math.min(1.9, 0.75 * 60 / bpm));
    }
    applyProject(p, opts = {}) {
      const cfgs = {};
      BEAT_CHANNELS.forEach(c => { cfgs[c] = p.mix[c]; });
      p.tracks.forEach(t => { cfgs[t.id] = t.cfg; });
      const ids = Object.keys(cfgs);
      const anySolo = ids.some(id => cfgs[id].solo);
      ids.forEach(id => {
        const c = cfgs[id];
        const isTrack = !BEAT_CHANNELS.includes(id);
        let muted = c.mute || (anySolo && !c.solo);
        if (opts.instrumental && isTrack) muted = true;
        if (opts.vocalsOnly && !isTrack) muted = true;
        if (this.offline) this.leanChannel(id, c, muted);
        else this.applyChannel(id, c, muted);
      });
      this.applyMaster(p.master, p.bpm);
    }
  }

  // ---------- live player ----------
  class Player {
    constructor() { this.ctx = null; this.playing = false; this.sources = []; this.outs = {}; }
    ensure() {
      if (!this.ctx) {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
        this.mixer = new Mixer(this.ctx, this.ctx.destination, { analyser: true });
        this.metro = this.ctx.createGain();
        this.metro.gain.value = 0.6;
        this.metro.connect(this.ctx.destination);
        this.preview = this.ctx.createGain();
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    }
    out(id) {
      if (!this.outs[id]) {
        const g = this.ctx.createGain();
        g.connect(this.mixer.input(id));
        this.outs[id] = g;
      }
      return this.outs[id];
    }
    // opts: { loop: sectionId | null, from: seconds, preRoll: seconds, metronome, recording, onEnd }
    play(p, buffers, opts) {
      this.stop();
      const ctx = this.ensure();
      this.p = p; this.buffers = buffers; this.opts = opts;
      this.mixer.applyProject(p);
      this.sd = stepDur(p);
      const lead = 0.08;
      if (opts.loop) {
        this.zero = ctx.currentTime + lead;
        this.next = 0;
      } else {
        const from = opts.from - (opts.preRoll || 0);
        this.zero = ctx.currentTime + lead - from;
        this.next = Math.ceil(from / this.sd - 1e-6);
        this.endTime = songLength(p) + 0.3;
        this.scheduleClips(Math.max(0, opts.from - (opts.preRoll || 0)));
      }
      this.playing = true;
      this.timer = setInterval(() => this.tick(), 25);
      this.tick();
    }
    scheduleClips(from) {
      this.sources.forEach(s => { try { s.stop(); } catch (e) { /* already stopped */ } });
      this.sources = [];
      for (const tr of this.p.tracks) {
        if (this.opts.recording && tr.id === this.opts.recordTrack && !this.opts.hearTrack) continue;
        for (const c of tr.clips) {
          const s = scheduleClip(this.ctx, this.mixer.input(tr.id), c, this.buffers.get(c.bufferId), this.zero, from);
          if (s) this.sources.push(s);
        }
      }
    }
    refreshClips() {
      if (!this.playing || this.opts.loop) return;
      const pos = this.ctx.currentTime + 0.05 - this.zero;
      this.endTime = songLength(this.p) + 0.3;
      this.scheduleClips(Math.max(0, pos));
    }
    tick() {
      const ctx = this.ctx, p = this.p, sd = this.sd;
      const horizon = ctx.currentTime + 0.12;
      const map = this.opts.loop ? null : songMap(p);
      const loopSec = this.opts.loop ? p.sections.find(s => s.id === this.opts.loop) : null;
      if (this.opts.loop && !loopSec) return; // looped section was deleted
      while (this.zero + this.next * sd < horizon) {
        const n = this.next++;
        const t = this.zero + n * sd;
        if (loopSec) {
          const sIdx = n % (loopSec.bars * 16);
          if (this.opts.metronome && n % 4 === 0) Synth.click(ctx, this.metro, t, sIdx % 16 === 0);
          scheduleStep(ctx, id => this.out(id), p, loopSec, sIdx, t + swingOffset(p, sIdx % 16, sd), sd);
        } else {
          if (n < 0) {
            if (n % 4 === 0) Synth.click(ctx, this.metro, t, ((n % 16) + 16) % 16 === 0);
            continue;
          }
          if (this.opts.metronome && n % 4 === 0) Synth.click(ctx, this.metro, t, n % 16 === 0);
          const it = locate(map, n);
          if (it) {
            const sIdx = n - it.start;
            scheduleStep(ctx, id => this.out(id), p, it.sec, sIdx, t + swingOffset(p, sIdx % 16, sd), sd);
          }
        }
      }
      if (!this.opts.loop && !this.opts.recording && ctx.currentTime > this.zero + this.endTime) {
        const cb = this.opts.onEnd;
        this.stop();
        if (cb) cb();
      }
    }
    // Where the listener currently is (compensating for output latency)
    position() {
      if (!this.playing) return null;
      const ctx = this.ctx;
      const t = ctx.currentTime - (ctx.outputLatency || 0) - this.zero;
      if (this.opts.loop) {
        const sec = this.p.sections.find(s => s.id === this.opts.loop);
        if (!sec) return { pos: 0, secId: null, sIdx: -1 };
        const L = sec.bars * 16 * this.sd;
        const pos = ((t % L) + L) % L;
        return { pos, secId: sec.id, sIdx: Math.floor(pos / this.sd), loop: true };
      }
      const n = Math.floor(t / this.sd);
      const it = n >= 0 ? locate(songMap(this.p), n) : null;
      return { pos: t, secId: it ? it.sec.id : null, sIdx: it ? n - it.start : -1, arrIndex: it ? it.index : -1 };
    }
    stop() {
      if (!this.playing) return;
      this.playing = false;
      clearInterval(this.timer);
      this.sources.forEach(s => { try { s.stop(); } catch (e) { /* already stopped */ } });
      this.sources = [];
      const now = this.ctx.currentTime;
      Object.values(this.outs).forEach(g => {
        g.gain.setTargetAtTime(0, now, 0.015);
        setTimeout(() => g.disconnect(), 200);
      });
      this.outs = {};
    }
    // Audition a sound immediately (used by the editors)
    audition(fn) {
      const ctx = this.ensure();
      fn(ctx, id => this.mixer.input(id), ctx.currentTime + 0.02);
    }
  }

  // ---------- offline render / export ----------
  async function render(p, buffers, opts = {}) {
    const sr = opts.sampleRate || 44100;
    const len = songLength(p) + 3;
    if (!opts.vocalsOnly) await Synth.warm(collectEvents(p), sr);
    const ctx = new OfflineAudioContext(2, Math.ceil(len * sr), sr);
    const mixer = new Mixer(ctx, ctx.destination);
    mixer.applyProject(p, opts);
    const sd = stepDur(p);
    if (!opts.vocalsOnly) {
      // Schedule the beat in small chunks as rendering progresses: creating every note up front
      // would make the audio graph huge and the render extremely slow.
      const events = [];
      for (const it of songMap(p).items) {
        for (let i = 0; i < it.steps; i++) events.push({ sec: it.sec, i, t: 0.01 + (it.start + i) * sd + swingOffset(p, i % 16, sd) });
      }
      let idx = 0;
      const out = id => mixer.input(id);
      const until = tEnd => {
        while (idx < events.length && events[idx].t < tEnd) {
          const e = events[idx++];
          scheduleStep(ctx, out, p, e.sec, e.i, e.t, sd);
        }
      };
      const CHUNK = 1;
      until(CHUNK * 2);
      for (let s = CHUNK; s < len - CHUNK; s += CHUNK) {
        const at = s;
        ctx.suspend(at).then(() => { until(at + CHUNK * 2); ctx.resume(); });
      }
    }
    if (!opts.instrumental) {
      p.tracks.forEach(tr => tr.clips.forEach(c => scheduleClip(ctx, mixer.input(tr.id), c, buffers.get(c.bufferId), 0.01, 0)));
    }
    const out = await ctx.startRendering();
    return trimSilence(out);
  }
  function trimSilence(buf) {
    const th = 0.0005;
    let end = buf.length;
    const chans = [...Array(buf.numberOfChannels)].map((_, i) => buf.getChannelData(i));
    outer: while (end > 1) {
      for (const c of chans) if (Math.abs(c[end - 1]) > th) break outer;
      end--;
    }
    end = Math.min(buf.length, end + Math.floor(buf.sampleRate * 0.3));
    if (end >= buf.length) return buf;
    const nb = new AudioBuffer({ length: Math.max(end, 1), numberOfChannels: buf.numberOfChannels, sampleRate: buf.sampleRate });
    chans.forEach((c, i) => nb.copyToChannel(c.subarray(0, end), i));
    return nb;
  }

  function wav(buf) {
    const nCh = buf.numberOfChannels, sr = buf.sampleRate, len = buf.length;
    const bytes = 44 + len * nCh * 2;
    const ab = new ArrayBuffer(bytes);
    const dv = new DataView(ab);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); dv.setUint32(4, bytes - 8, true); w(8, 'WAVE'); w(12, 'fmt ');
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, nCh, true);
    dv.setUint32(24, sr, true); dv.setUint32(28, sr * nCh * 2, true); dv.setUint16(32, nCh * 2, true);
    dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, len * nCh * 2, true);
    const chans = [...Array(nCh)].map((_, i) => buf.getChannelData(i));
    let o = 44;
    for (let i = 0; i < len; i++) {
      for (let c = 0; c < nCh; c++) {
        const s = Math.max(-1, Math.min(1, chans[c][i]));
        dv.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        o += 2;
      }
    }
    return new Blob([ab], { type: 'audio/wav' });
  }

  // Waveform overview (min/max per 1/200 s), cached per buffer
  const peakCache = new WeakMap();
  function peaks(buf) {
    if (peakCache.has(buf)) return peakCache.get(buf);
    const rate = 200;
    const per = Math.max(1, Math.floor(buf.sampleRate / rate));
    const n = Math.ceil(buf.length / per);
    const min = new Float32Array(n), max = new Float32Array(n);
    const chans = [...Array(buf.numberOfChannels)].map((_, i) => buf.getChannelData(i));
    for (let i = 0; i < n; i++) {
      let mn = 0, mx = 0;
      const a = i * per, b = Math.min(buf.length, a + per);
      for (const c of chans) for (let j = a; j < b; j++) { const v = c[j]; if (v > mx) mx = v; if (v < mn) mn = v; }
      min[i] = mn; max[i] = mx;
    }
    const res = { rate: buf.sampleRate / per, min, max };
    peakCache.set(buf, res);
    return res;
  }

  return { BEAT_CHANNELS, KEY_STYLES, stepDur, barDur, songMap, locate, songLength, swingOffset, scheduleStep, stepEvents, collectEvents, scheduleClip, clipEnvelope, Mixer, Player, render, wav, peaks };
})();
