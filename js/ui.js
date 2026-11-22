'use strict';
/*
 * UI — the Beats Studio application: beat maker, arranger/recorder, mixer, transport.
 */
const $ = s => document.querySelector(s);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const fromDB = d => Math.pow(10, d / 20);
const toDB = g => 20 * Math.log10(Math.max(g, 1e-6));

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  let value;
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'value') { value = v; continue; }
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') {
      for (const [sk, sv] of Object.entries(v)) { if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv; }
    } else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
  if (value !== undefined) el.value = value;
  return el;
}
function selectEl(options, value, onchange, attrs = {}) {
  const entries = Array.isArray(options) ? options : Object.entries(options);
  return h('select', Object.assign({}, attrs, { onchange: e => onchange(e.target.value), value: String(value) }),
    entries.map(([v, l]) => h('option', { value: String(v) }, l)));
}
function sliderEl(label, value, min, max, step, fmt, onInput, onChange, attrs = {}) {
  const out = h('span', { class: 'val' }, fmt(value));
  const inp = h('input', {
    type: 'range', min, max, step, value,
    oninput: e => { const v = +e.target.value; out.textContent = fmt(v); onInput(v); },
    onchange: () => onChange && onChange()
  });
  return h('label', Object.assign({ class: 'slider' }, attrs), h('span', { class: 'lbl' }, label), inp, out);
}
function download(blob, name) {
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
}
let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

const KEY_STYLE_NAMES = {
  block: 'Held chords', pulse: 'Quarter-note pulse', eighths: 'Eighth-note pulse', stabs: 'Off-beat stabs',
  arp: 'Arpeggio', ballad: 'Ballad (held + soft pulse)', comp: 'Jazz comping', broken: 'Classical broken chords'
};
const BASS_STYLE_NAMES = {
  root: 'Long root notes', pulse8: 'Eighth-note pulse', octave: 'Octave bounce', syncopated: 'Syncopated groove',
  walking: 'Walking bass (jazz)', '808': '808 follows the kick', none: 'Silent'
};
const CHANNEL_NAMES = { drums: 'Drums', bass: 'Bass', keys: 'Keys', pad: 'Pad', melody: 'Melody' };
const VOCAL_PRESETS = {
  'Clean vocal': { hp: true, low: -2, mid: 1, high: 3, comp: 0.45, reverb: 0.15, delay: 0 },
  'Rap vocal': { hp: true, low: -3, mid: 2, high: 4, comp: 0.65, reverb: 0.06, delay: 0.08 },
  'Worship / ballad': { hp: true, low: -2, mid: 0, high: 3, comp: 0.5, reverb: 0.45, delay: 0.18 },
  'Choir / backing': { hp: true, low: -4, mid: -2, high: 2, comp: 0.4, reverb: 0.55, delay: 0.1, vol: 0.55 },
  'Radio / phone': { hp: true, low: -12, mid: 8, high: -10, comp: 0.7, reverb: 0.05, delay: 0 },
  'Flat (no effects)': { hp: false, low: 0, mid: 0, high: 0, comp: 0, reverb: 0, delay: 0 }
};
const HEADER_W = 190;
const SNAP_NAMES = { off: 'Off', bar: 'Bar', beat: 'Beat', '16': '1/16' };

const App = {
  p: null,
  buffers: new Map(),
  tab: 'beat',
  selSection: null, selTrack: null, selClip: null, selArr: -1,
  playhead: 0, playFrom: 0,
  loopMode: true, metronome: false, countIn: true,
  recording: false, replaceMode: true,
  zoom: 50, snap: 'beat',
  undo: [], redo: [], lastSnap: null,
  hlStep: -1, hlMel: -1,

  // ===================== startup =====================
  async init() {
    this.player = new Engine.Player();
    this.rec = new Recorder();
    try { const l = localStorage.getItem('beats-latency'); if (l !== null) this.latencyMs = +l; } catch (e) { /* storage blocked */ }
    this.bindTop();
    this.bindKeys();
    this.buildGenreDialog();
    let p = null;
    try { p = await Store.loadProject(); } catch (e) { console.warn('Could not load autosave', e); }
    if (p && p.sections && p.sections.length) {
      await this.loadBuffersFor(p);
      this.setProject(p);
    } else {
      this.setProject(Presets.build('worship'));
      this.openNewDialog(true);
    }
    requestAnimationFrame(() => this.frame());
  },

  async loadBuffersFor(p) {
    const used = new Set();
    p.tracks.forEach(t => t.clips.forEach(c => used.add(c.bufferId)));
    for (const id of used) {
      try { const b = await Store.loadBuffer(id); if (b) this.buffers.set(id, b); } catch (e) { console.warn(e); }
    }
    try { // remove recordings no longer used by the project
      for (const k of await Store.bufferKeys()) if (!used.has(k)) Store.deleteBuffer(k);
    } catch (e) { /* ignore */ }
  },

  migrate(p) {
    p.tracks = p.tracks || [];
    p.drumVol = Object.assign(Object.fromEntries(Synth.DRUMS.map(k => [k, 0.8])), p.drumVol || {});
    p.mix = p.mix || {};
    Engine.BEAT_CHANNELS.forEach(c => { p.mix[c] = Presets.channel(p.mix[c] || {}); });
    p.master = Object.assign({ vol: 0.85, glue: true, loud: 3 }, p.master || {});
    p.inst = Object.assign({ keys: 'piano', pad: 'pad', bass: 'electric', melody: 'bell' }, p.inst || {});
    p.swingGrid = p.swingGrid || '16';
    p.sections.forEach(s => {
      s.drums = Object.assign(Presets.drums({}), s.drums || {});
      if (!s.melody) s.melody = Presets.emptyMelody(32);
      s.melodyLen = s.melody[0].length;
    });
    p.arrangement = (p.arrangement || []).filter(id => p.sections.some(s => s.id === id));
    if (!p.arrangement.length) p.arrangement = [p.sections[0].id];
    p.tracks.forEach(t => { t.cfg = Presets.channel(t.cfg || {}); t.clips = t.clips || []; });
    return p;
  },

  setProject(p) {
    this.player.stop();
    this.p = this.migrate(p);
    this.undo = []; this.redo = [];
    this.lastSnap = JSON.stringify(this.p);
    this.selSection = this.p.sections[0].id;
    this.selTrack = this.p.tracks[0] ? this.p.tracks[0].id : null;
    this.selClip = null; this.selArr = -1;
    this.playhead = 0;
    if (this.player.ctx) this.player.mixer.applyProject(this.p);
    this.render();
    this.scheduleSave();
    this.warmLater();
  },

  // ===================== state changes =====================
  commit(opts = {}) {
    const snap = JSON.stringify(this.p);
    if (snap !== this.lastSnap) {
      this.undo.push(this.lastSnap);
      if (this.undo.length > 150) this.undo.shift();
      this.redo = [];
      this.lastSnap = snap;
      this.scheduleSave();
      this.warmLater();
    }
    this.live();
    if (opts.render !== false) this.render();
  },
  live() {
    if (this.player.ctx) this.player.mixer.applyProject(this.p);
    if (this.player.playing && !this.recording) this.player.refreshClips();
  },
  doUndo() {
    if (!this.undo.length) return toast('Nothing to undo');
    this.redo.push(this.lastSnap);
    this.lastSnap = this.undo.pop();
    this.restoreSnap();
  },
  doRedo() {
    if (!this.redo.length) return toast('Nothing to redo');
    this.undo.push(this.lastSnap);
    this.lastSnap = this.redo.pop();
    this.restoreSnap();
  },
  restoreSnap() {
    this.p = JSON.parse(this.lastSnap);
    if (!this.p.sections.some(s => s.id === this.selSection)) this.selSection = this.p.sections[0].id;
    if (this.selClip && !this.findClip(this.selClip)) this.selClip = null;
    this.live();
    this.render();
    this.scheduleSave();
  },
  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => Store.saveProject(this.p).catch(e => console.warn('Autosave failed', e)), 800);
  },

  audio() {
    const ctx = this.player.ensure();
    this.player.mixer.applyProject(this.p);
    if (this.latencyMs == null) {
      this.latencyMs = Math.round(((ctx.outputLatency || 0) + (ctx.baseLatency || 0)) * 1000 + 10);
      const inp = $('#latency');
      if (inp) inp.value = this.latencyMs;
    }
    return ctx;
  },

  // ===================== helpers =====================
  curSection() { return this.p.sections.find(s => s.id === this.selSection) || this.p.sections[0]; },
  secById(id) { return this.p.sections.find(s => s.id === id); },
  sectionHue(sec) { return (this.p.sections.indexOf(sec) * 67 + 200) % 360; },
  trackHue(i) { return (i * 53 + 15) % 360; },
  findClip(id) {
    for (const t of this.p.tracks) { const c = t.clips.find(x => x.id === id); if (c) return { track: t, clip: c }; }
    return null;
  },
  arrStart(i) {
    const map = Engine.songMap(this.p);
    const it = map.items.find(x => x.index === i);
    return it ? it.start * Engine.stepDur(this.p) : 0;
  },
  snapTime(t, ev) {
    if (ev && ev.shiftKey) return t;
    const sd = Engine.stepDur(this.p);
    const unit = { off: 0, bar: sd * 16, beat: sd * 4, '16': sd }[this.snap];
    return unit ? Math.round(t / unit) * unit : t;
  },
  fmtBars(sec) {
    const n = Math.floor(sec / Engine.stepDur(this.p) + 1e-6);
    if (n < 0) return 'count-in';
    return `${Math.floor(n / 16) + 1}.${Math.floor((n % 16) / 4) + 1}.${(n % 4) + 1}`;
  },
  fmtTime(sec) {
    const s = Math.max(0, sec);
    return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
  },

  // ===================== top bar =====================
  bindTop() {
    $('#key').append(...Theory.NOTES.map((n, i) => h('option', { value: i }, n)));
    $('#scale').append(...Object.entries(Theory.SCALE_NAMES).map(([v, l]) => h('option', { value: v }, l)));
    $('#projName').addEventListener('change', e => { this.p.name = e.target.value || 'Untitled Song'; this.commit({ render: false }); });
    $('#bpm').addEventListener('change', e => {
      const v = clamp(Math.round(+e.target.value || 100), 40, 220);
      e.target.value = v;
      if (v === this.p.bpm) return;
      if (this.p.tracks.some(t => t.clips.length)) toast('Tip: recordings keep their timing, so a new tempo may put them out of sync with the beat.', 4500);
      this.p.bpm = v;
      this.restartIfPlaying();
      this.commit();
    });
    $('#key').addEventListener('change', e => { this.p.key = +e.target.value; this.commit(); });
    $('#scale').addEventListener('change', e => { this.p.scale = e.target.value; this.commit(); });
    $('#swing').addEventListener('input', e => { this.p.swing = +e.target.value / 100; $('#swingVal').textContent = e.target.value + '%'; });
    $('#swing').addEventListener('change', () => this.commit({ render: false }));
    $('#btnPlay').addEventListener('click', () => this.togglePlay());
    $('#btnStop').addEventListener('click', () => this.stop());
    $('#btnRec').addEventListener('click', () => this.toggleRecord());
    $('#modeLoop').addEventListener('click', () => this.setLoopMode(true));
    $('#modeSong').addEventListener('click', () => this.setLoopMode(false));
    $('#metro').addEventListener('change', e => { this.metronome = e.target.checked; this.restartIfPlaying(); });
    $('#countIn').addEventListener('change', e => { this.countIn = e.target.checked; });
    $('#btnUndo').addEventListener('click', () => this.doUndo());
    $('#btnRedo').addEventListener('click', () => this.doRedo());
    $('#btnNew').addEventListener('click', () => this.openNewDialog(false));
    $('#newCancel').addEventListener('click', () => $('#dlgNew').close());
    $('#btnSave').addEventListener('click', () => this.saveFile());
    $('#btnOpen').addEventListener('click', () => $('#fileOpen').click());
    $('#fileOpen').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) this.openFile(f); });
    $('#btnExport').addEventListener('click', () => { $('#exportStatus').textContent = ''; $('#dlgExport').showModal(); });
    $('#exportClose').addEventListener('click', () => $('#dlgExport').close());
    document.querySelectorAll('[data-export]').forEach(b => b.addEventListener('click', () => this.exportAudio(b.dataset.export)));
    $('#fileAudio').addEventListener('change', e => { const fs = [...e.target.files]; e.target.value = ''; this.importAudio(fs); });
    document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => this.setTab(b.dataset.tab)));
    window.addEventListener('pointerup', () => {
      if (this.paint || this.melPaint) { this.paint = null; this.melPaint = null; this.commit({ render: false }); }
    });
  },

  renderTop() {
    const p = this.p;
    $('#projName').value = p.name;
    $('#bpm').value = p.bpm;
    $('#key').value = p.key;
    $('#scale').value = p.scale;
    $('#swing').value = Math.round(p.swing * 100);
    $('#swingVal').textContent = Math.round(p.swing * 100) + '%';
    $('#btnUndo').disabled = !this.undo.length;
    $('#btnRedo').disabled = !this.redo.length;
    this.updateTransport();
  },

  updateTransport() {
    $('#btnPlay').classList.toggle('active', this.player.playing && !this.recording);
    $('#btnPlay').textContent = this.player.playing ? '❚❚' : '▶';
    $('#btnRec').classList.toggle('recording', this.recording);
    $('#modeLoop').classList.toggle('active', this.loopMode);
    $('#modeSong').classList.toggle('active', !this.loopMode);
  },

  setTab(tab) {
    this.tab = tab;
    document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.tabpage').forEach(s => s.classList.toggle('active', s.id === 'tab-' + tab));
    this.renderTab();
  },

  render() { this.renderTop(); this.renderTab(); },
  renderTab() {
    if (this.tab === 'beat') this.renderBeat();
    else if (this.tab === 'arrange') this.renderArrange();
    else if (this.tab === 'mixer') this.renderMixer();
  },

  // ===================== transport =====================
  setLoopMode(on) {
    if (this.recording) return;
    this.loopMode = on;
    this.restartIfPlaying();
    this.updateTransport();
  },
  // Pre-render the sounds that are about to play (first time only), waiting at most a few seconds
  async prepareSounds(onlySection) {
    const sr = this.player.ctx.sampleRate;
    const evs = Engine.collectEvents(this.p, onlySection);
    if (Synth.isReady(evs, sr)) return;
    $('#btnPlay').textContent = '…';
    toast('Preparing sounds…', 1500);
    await Promise.race([Synth.warm(evs, sr), new Promise(r => setTimeout(r, 6000))]);
  },
  warmLater() {
    if (!this.player.ctx) return;
    clearTimeout(this.warmTimer);
    this.warmTimer = setTimeout(() => Synth.warm(Engine.collectEvents(this.p), this.player.ctx.sampleRate), 400);
  },
  async play() {
    this.audio();
    if (this.preparing) return;
    this.preparing = true;
    try { await this.prepareSounds(this.loopMode ? this.selSection : null); } finally { this.preparing = false; }
    this.warmLater();
    if (this.loopMode) {
      this.player.play(this.p, this.buffers, { loop: this.selSection, metronome: this.metronome });
    } else {
      this.playFrom = this.playhead;
      this.player.play(this.p, this.buffers, {
        from: this.playhead, metronome: this.metronome,
        onEnd: () => { this.playhead = this.playFrom; this.updateTransport(); }
      });
    }
    this.updateTransport();
  },
  stop() {
    if (this.recording) return this.stopRecording();
    if (this.player.playing) {
      this.player.stop();
      if (!this.loopMode) this.playhead = this.playFrom;
    } else {
      this.playhead = 0;
    }
    this.updateTransport();
  },
  togglePlay() {
    if (this.recording) return this.stopRecording();
    if (this.player.playing) this.stop(); else this.play();
  },
  restartIfPlaying() {
    if (!this.player.playing || this.recording) return;
    if (!this.loopMode && !this.player.opts.loop) {
      const info = this.player.position();
      if (info) this.playhead = Math.max(0, info.pos);
    }
    this.play();
  },
  seek(t) {
    this.playhead = Math.max(0, t);
    if (this.player.playing && !this.loopMode && !this.recording) this.play();
  },

  // ===================== recording =====================
  latency() { return (this.latencyMs ?? 20) / 1000; },

  async toggleRecord() {
    if (this.recording) return this.stopRecording();
    try {
      this.audio();
      await this.rec.init(this.player.ctx);
    } catch (e) {
      toast('Microphone not available: ' + (e.message || e.name) + '. Allow microphone access and open the app via http://localhost (npm start).', 7000);
      return;
    }
    let track = this.p.tracks.find(t => t.armed) || this.p.tracks.find(t => t.id === this.selTrack);
    if (!track) track = this.addTrack(null, false);
    this.p.tracks.forEach(t => { t.armed = t === track; });
    this.loopMode = false;
    this.updateTransport();
    await this.prepareSounds(null);
    this.recTrack = track.id;
    this.recFrom = this.playhead;
    this.playFrom = this.playhead;
    const pre = this.countIn ? Engine.barDur(this.p) : 0;
    this.player.play(this.p, this.buffers, { from: this.playhead, preRoll: pre, metronome: this.metronome, recording: true });
    this.recZero = this.player.zero;
    this.rec.start();
    this.recording = true;
    if (this.tab !== 'arrange') this.setTab('arrange'); else this.renderArrange();
    this.updateTransport();
    toast(this.countIn ? 'Count-in… then sing!' : 'Recording…');
  },

  stopRecording() {
    const r = this.rec.stop();
    this.player.stop();
    this.recording = false;
    this.playhead = this.recFrom;
    this.updateTransport();
    const track = this.p.tracks.find(t => t.id === this.recTrack);
    if (!r || !track) { this.render(); return; }
    let start = (r.startTime - this.recZero) - this.latency();
    let offset = 0;
    if (start < this.recFrom) { offset = this.recFrom - start; start = this.recFrom; }
    const duration = r.buffer.duration - offset;
    if (duration < 0.15) { toast('Recording was too short'); this.render(); return; }
    const id = this.addBuffer(r.buffer);
    const takeNo = (track.takes = (track.takes || 0) + 1);
    const clip = { id: Presets.uid('c_'), name: 'Take ' + takeNo, bufferId: id, start, offset, duration, gain: 1, fadeIn: 0.01, fadeOut: 0.03 };
    if (this.replaceMode) this.carve(track, start, start + duration, null);
    track.clips.push(clip);
    this.selClip = clip.id;
    this.selTrack = track.id;
    this.commit();
    toast(`Recorded ${clip.name} on “${track.name}” ✓`);
  },

  // Remove the part of existing clips covered by [s, e] (punch-in replace)
  carve(track, s, e, keep) {
    const out = [];
    for (const c of track.clips) {
      const cs = c.start, ce = c.start + c.duration;
      if (c === keep || ce <= s || cs >= e) { out.push(c); continue; }
      if (cs < s) out.push(Object.assign({}, c, { id: Presets.uid('c_'), duration: s - cs, fadeOut: 0.01 }));
      if (ce > e) out.push(Object.assign({}, c, { id: Presets.uid('c_'), start: e, offset: c.offset + (e - cs), duration: ce - e, fadeIn: 0.01 }));
    }
    track.clips = out;
  },

  addBuffer(buf) {
    const id = Presets.uid('b_');
    this.buffers.set(id, buf);
    Store.saveBuffer(id, buf).catch(e => { console.warn(e); toast('Warning: could not autosave the recording in the browser. Use Save to keep it.', 5000); });
    return id;
  },

  // ===================== tracks & clips =====================
  addTrack(name, doCommit = true) {
    const n = this.p.tracks.length + 1;
    const t = {
      id: Presets.uid('t_'), name: name || 'Vocal ' + n, armed: !this.p.tracks.some(x => x.armed),
      cfg: Presets.channel({ vol: 0.75, hp: true, low: -2, mid: 1, high: 3, comp: 0.45, reverb: 0.15 }), clips: []
    };
    this.p.tracks.push(t);
    this.selTrack = t.id;
    if (doCommit) this.commit();
    return t;
  },
  deleteTrack(t) {
    if (t.clips.length && !confirm(`Delete track “${t.name}” and its ${t.clips.length} clip(s)?`)) return;
    this.p.tracks = this.p.tracks.filter(x => x !== t);
    if (this.selTrack === t.id) this.selTrack = this.p.tracks[0] ? this.p.tracks[0].id : null;
    this.selClip = null;
    this.commit();
  },
  async importAudio(files) {
    if (!files.length) return;
    const ctx = this.audio();
    let track = this.p.tracks.find(t => t.id === this.selTrack);
    for (const f of files) {
      try {
        const buf = await ctx.decodeAudioData(await f.arrayBuffer());
        const id = this.addBuffer(buf);
        const tr = track || this.addTrack(f.name.replace(/\.[^.]+$/, '').slice(0, 24), false);
        track = null;
        const clip = { id: Presets.uid('c_'), name: f.name.replace(/\.[^.]+$/, ''), bufferId: id, start: this.playhead, offset: 0, duration: buf.duration, gain: 1, fadeIn: 0, fadeOut: 0 };
        tr.clips.push(clip);
        this.selClip = clip.id;
        this.selTrack = tr.id;
      } catch (e) {
        toast(`Could not import ${f.name}: unsupported audio format`, 4000);
      }
    }
    this.commit();
  },
  selected() { return this.selClip ? this.findClip(this.selClip) : null; },
  splitClip() {
    const ph = this.player.playing && !this.loopMode ? Math.max(0, this.player.position().pos) : this.playhead;
    let targets = [];
    const sel = this.selected();
    if (sel && ph > sel.clip.start && ph < sel.clip.start + sel.clip.duration) targets = [sel];
    else {
      const tr = this.p.tracks.find(t => t.id === this.selTrack);
      if (tr) targets = tr.clips.filter(c => ph > c.start && ph < c.start + c.duration).map(c => ({ track: tr, clip: c }));
    }
    if (!targets.length) return toast('Put the playhead over a clip to split it');
    for (const { track, clip } of targets) {
      const d = ph - clip.start;
      const b = Object.assign({}, clip, { id: Presets.uid('c_'), start: ph, offset: clip.offset + d, duration: clip.duration - d, fadeIn: 0.005, fadeOut: clip.fadeOut });
      clip.duration = d;
      clip.fadeOut = 0.005;
      clip.fadeIn = Math.min(clip.fadeIn || 0, d);
      track.clips.push(b);
      this.selClip = b.id;
    }
    this.commit();
  },
  duplicateClip() {
    const sel = this.selected();
    if (!sel) return toast('Select a clip first');
    const c = Object.assign({}, sel.clip, { id: Presets.uid('c_'), start: sel.clip.start + sel.clip.duration });
    sel.track.clips.push(c);
    this.selClip = c.id;
    this.commit();
  },
  deleteClip() {
    const sel = this.selected();
    if (!sel) return toast('Select a clip first');
    sel.track.clips = sel.track.clips.filter(c => c !== sel.clip);
    this.selClip = null;
    this.commit();
  },
  normalizeClip() {
    const sel = this.selected();
    if (!sel) return;
    const buf = this.buffers.get(sel.clip.bufferId);
    if (!buf) return;
    const a = Math.floor(sel.clip.offset * buf.sampleRate), b = Math.min(buf.length, Math.floor((sel.clip.offset + sel.clip.duration) * buf.sampleRate));
    let pk = 0;
    for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = a; i < b; i++) pk = Math.max(pk, Math.abs(d[i])); }
    if (pk < 1e-4) return toast('This clip is silent');
    sel.clip.gain = Math.min(16, 0.89 / pk);
    this.commit();
    toast(`Normalized (${toDB(sel.clip.gain) >= 0 ? '+' : ''}${toDB(sel.clip.gain).toFixed(1)} dB)`);
  },
  reverseClip() {
    const sel = this.selected();
    if (!sel) return;
    const buf = this.buffers.get(sel.clip.bufferId);
    if (!buf) return;
    const nb = new AudioBuffer({ length: buf.length, numberOfChannels: buf.numberOfChannels, sampleRate: buf.sampleRate });
    for (let c = 0; c < buf.numberOfChannels; c++) nb.copyToChannel(buf.getChannelData(c).slice().reverse(), c);
    sel.clip.bufferId = this.addBuffer(nb);
    sel.clip.offset = buf.duration - (sel.clip.offset + sel.clip.duration);
    const fi = sel.clip.fadeIn; sel.clip.fadeIn = sel.clip.fadeOut; sel.clip.fadeOut = fi;
    this.commit();
  },

  // ===================== sections =====================
  addSection() {
    const s = Presets.section('Section ' + (this.p.sections.length + 1), 4, 'I | IV | V | I', {}, { drumsOn: true });
    this.p.sections.push(s);
    this.p.arrangement.push(s.id);
    this.selSection = s.id;
    this.commit();
    toast('New section added at the end of the song');
  },
  duplicateSection(sec) {
    const s = JSON.parse(JSON.stringify(sec));
    s.id = Presets.uid('s_');
    s.name = sec.name + ' (copy)';
    this.p.sections.push(s);
    const last = this.p.arrangement.lastIndexOf(sec.id);
    this.p.arrangement.splice(last + 1, 0, s.id);
    this.selSection = s.id;
    this.commit();
  },
  deleteSection(sec) {
    if (this.p.sections.length < 2) return toast('A song needs at least one section');
    if (!confirm(`Delete section “${sec.name}”? It will be removed from the song structure too.`)) return;
    this.p.sections = this.p.sections.filter(s => s !== sec);
    this.p.arrangement = this.p.arrangement.filter(id => id !== sec.id);
    if (!this.p.arrangement.length) this.p.arrangement = [this.p.sections[0].id];
    this.selSection = this.p.sections[0].id;
    if (this.player.playing && this.loopMode) this.play();
    this.commit();
  },
  selectSection(id) {
    this.selSection = id;
    if (this.player.playing && this.loopMode) this.play();
    this.renderBeat();
  },

  // ===================== auditioning =====================
  previewDrum(k) {
    this.audio();
    this.player.audition((ctx, out, t) => Synth.drum(ctx, out('drums'), k, t, (this.p.drumVol[k] ?? 0.8) * 1.25, this.p.kit));
  },
  previewNote(ch, inst, m, dur = 0.5) {
    this.audio();
    this.player.audition((ctx, out, t) => Synth.note(ctx, out(ch), inst, m, t, dur, 0.75));
  },
  previewChord(ch, inst) {
    this.audio();
    const c = Theory.parseChord(Theory.parseProgression(this.curSection().prog)[0][0], this.p.key) || Theory.parseChord('I', this.p.key);
    const notes = ch === 'bass' ? [Theory.bassRoot(this.p.key, c, 33)] : Theory.voice(this.p.key, c, ch === 'pad' ? 58 : 62);
    this.player.audition((ctx, out, t) => notes.forEach(m => Synth.note(ctx, out(ch), inst, m, t, ch === 'pad' ? 2 : 1, 0.65)));
  },

  // ===================== BEAT MAKER =====================
  renderBeat() {
    const p = this.p;
    const root = $('#tab-beat');
    root.innerHTML = '';
    const sec = this.curSection();
    this.hlStep = -1; this.hlMel = -1;

    // --- section chips
    root.append(h('div', { class: 'chips' },
      h('span', { class: 'lbl' }, 'Sections'),
      p.sections.map(s => h('button', {
        class: 'chip' + (s === sec ? ' active' : ''), style: { '--hue': this.sectionHue(s) },
        onclick: () => this.selectSection(s.id)
      }, s.name, h('small', {}, ` ${s.bars} bars`))),
      h('button', { class: 'chip add', onclick: () => this.addSection() }, '+ New section')
    ));

    // --- section settings
    const names = h('div', { class: 'chord-names' });
    const showNames = () => {
      names.innerHTML = '';
      Theory.parseProgression(sec.prog).forEach((bar, i) => {
        names.append(h('span', { class: 'bar' }, h('small', {}, i + 1),
          bar.map(sym => { const n = Theory.chordName(p.key, sym); return h('b', { class: n ? '' : 'bad', title: n ? sym : 'Not understood: ' + sym }, n || sym + '?'); })));
      });
    };
    showNames();
    const toggles = [['drumsOn', 'Drums'], ['bassOn', 'Bass'], ['keysOn', 'Keys'], ['padOn', 'Pad'], ['melodyOn', 'Melody']];
    root.append(h('div', { class: 'panel' },
      h('div', { class: 'row' },
        h('label', { class: 'field' }, 'Section name', h('input', { value: sec.name, onchange: e => { sec.name = e.target.value || 'Section'; this.commit(); } })),
        h('label', { class: 'field small' }, 'Length', selectEl([1, 2, 4, 8, 12, 16].map(n => [n, n + (n === 1 ? ' bar' : ' bars')]), sec.bars, v => { sec.bars = +v; this.commit(); })),
        h('label', { class: 'field grow' }, 'Chords (bars separated by | )',
          h('input', { class: 'mono', value: sec.prog, spellcheck: 'false', oninput: e => { sec.prog = e.target.value; showNames(); }, onchange: () => this.commit({ render: false }) })),
        h('label', { class: 'field' }, 'Pick a progression',
          selectEl([['', 'Choose…'], ...Presets.PROGRESSIONS.map(([n, v]) => [v, n])], '', v => { if (v) { sec.prog = v; this.commit(); } }))
      ),
      names,
      h('div', { class: 'row' },
        h('div', { class: 'toggles' }, h('span', { class: 'lbl' }, 'Playing in this section:'),
          toggles.map(([k, l]) => h('label', { class: 'pill' + (sec[k] ? ' on' : '') },
            h('input', { type: 'checkbox', checked: sec[k], onchange: e => { sec[k] = e.target.checked; this.commit(); } }), l))),
        h('label', { class: 'field' }, 'Keys style', selectEl(KEY_STYLE_NAMES, sec.keysStyle, v => { sec.keysStyle = v; this.commit(); })),
        h('label', { class: 'field' }, 'Bass style', selectEl(BASS_STYLE_NAMES, sec.bassStyle, v => { sec.bassStyle = v; this.commit(); })),
        h('div', { class: 'spacer' }),
        h('button', { onclick: () => this.duplicateSection(sec) }, '⧉ Duplicate section'),
        h('button', { class: 'danger', onclick: () => this.deleteSection(sec) }, '🗑 Delete')
      )
    ));

    // --- sounds
    const instOpts = Object.entries(Synth.INSTRUMENTS).map(([k, v]) => [k, v.name]);
    const bassOpts = [...instOpts.filter(([k]) => Synth.INSTRUMENTS[k].bass), ...instOpts.filter(([k]) => !Synth.INSTRUMENTS[k].bass)];
    root.append(h('div', { class: 'panel' },
      h('h3', {}, 'Sounds ', h('small', { class: 'muted' }, '(used by the whole song)')),
      h('div', { class: 'row' },
        h('label', { class: 'field' }, 'Drum kit', selectEl(Object.entries(Synth.KITS).map(([k, v]) => [k, v.name]), p.kit, v => {
          p.kit = v; this.commit({ render: false });
          this.audio(); this.player.audition((ctx, out, t) => { Synth.drum(ctx, out('drums'), 'kick', t, 1, v); Synth.drum(ctx, out('drums'), 'snare', t + 0.3, 1, v); Synth.drum(ctx, out('drums'), 'hat', t + 0.45, 1, v); });
        })),
        [['keys', 'Keys'], ['pad', 'Pad'], ['bass', 'Bass'], ['melody', 'Melody']].map(([ch, l]) =>
          h('label', { class: 'field' }, l + ' sound', selectEl(ch === 'bass' ? bassOpts : instOpts, p.inst[ch], v => {
            p.inst[ch] = v; this.commit({ render: false });
            if (ch === 'melody') this.previewNote('melody', v, Theory.degreeMidi(p.key, p.scale, 7), 0.6); else this.previewChord(ch, v);
          })))
      )
    ));

    // --- drums
    const drumPanel = h('div', { class: 'panel' });
    drumPanel.append(h('div', { class: 'row head' },
      h('h3', {}, '🥁 Drums', sec.drumsOn ? '' : h('small', { class: 'warn' }, '  (drums are turned off in this section)')),
      h('div', { class: 'spacer' }),
      h('label', { class: 'field inline' }, 'Groove', selectEl([['', 'Load a groove…'], ...Presets.GROOVES.map(([n], i) => [i, n])], '', v => {
        if (v === '') return;
        sec.drums = Presets.drums(Presets.GROOVES[+v][1]); sec.drumsOn = true; this.commit();
      })),
      h('label', { class: 'field inline' }, 'Copy from', selectEl([['', 'Section…'], ...p.sections.filter(s => s !== sec).map(s => [s.id, s.name])], '', v => {
        const src = this.secById(v);
        if (src) { sec.drums = JSON.parse(JSON.stringify(src.drums)); this.commit(); }
      })),
      h('button', { onclick: () => { sec.drums = Presets.drums({}); this.commit(); } }, 'Clear')
    ));
    const grid = h('div', { class: 'drum-grid' + (sec.drumsOn ? '' : ' off') });
    grid.append(h('div', { class: 'drow steps' }, h('div', { class: 'dname' }), h('div', { class: 'dvol' }),
      [...Array(16)].map((_, i) => h('div', { class: 'stepno' + (i % 4 === 0 ? ' beat' : '') }, i % 4 === 0 ? i / 4 + 1 : ''))));
    this.drumCells = Array.from({ length: 16 }, () => []);
    const cls = v => 'cell' + (v === 1 ? ' on' : v === 0.5 ? ' ghost' : v >= 2 ? ' on roll' : '');
    for (const k of Synth.DRUMS) {
      const row = h('div', { class: 'drow' });
      row.append(h('button', { class: 'dname', title: 'Preview', onclick: () => this.previewDrum(k) }, Synth.DRUM_NAMES[k]));
      row.append(h('input', {
        class: 'dvol', type: 'range', min: 0, max: 1, step: 0.01, value: p.drumVol[k], title: Synth.DRUM_NAMES[k] + ' volume',
        oninput: e => { p.drumVol[k] = +e.target.value; }, onchange: () => { this.commit({ render: false }); this.previewDrum(k); }
      }));
      for (let i = 0; i < 16; i++) {
        const cell = h('div', { class: cls(sec.drums[k][i]) + (i % 4 === 0 ? ' beat' : '') + (Math.floor(i / 4) % 2 ? ' alt' : '') });
        const setV = v => {
          sec.drums[k][i] = v;
          cell.className = cls(v) + (i % 4 === 0 ? ' beat' : '') + (Math.floor(i / 4) % 2 ? ' alt' : '');
          cell.textContent = v >= 2 ? '×' + v : '';
        };
        cell.textContent = sec.drums[k][i] >= 2 ? '×' + sec.drums[k][i] : '';
        cell.addEventListener('pointerdown', e => {
          if (e.button !== 0) return;
          e.preventDefault();
          const cur = sec.drums[k][i];
          const nv = e.shiftKey ? (cur === 0.5 ? 0 : 0.5) : (cur ? 0 : 1);
          this.paint = { k, v: nv, sec };
          setV(nv);
          if (nv) this.previewDrum(k);
        });
        cell.addEventListener('pointerenter', e => {
          if (this.paint && this.paint.k === k && this.paint.sec === sec && (e.buttons & 1)) setV(this.paint.v);
        });
        cell.addEventListener('contextmenu', e => {
          e.preventDefault();
          const cur = sec.drums[k][i];
          setV(cur >= 2 ? (cur === 4 ? 1 : cur + 1) : 2);
          this.commit({ render: false });
        });
        this.drumCells[i].push(cell);
        row.append(cell);
      }
      grid.append(row);
    }
    drumPanel.append(grid, h('p', { class: 'hint' }, 'Click = hit · Shift+click = soft ghost note · Right-click = roll (×2, ×3, ×4) · Drag to paint · Slider = sound volume'));
    root.append(drumPanel);

    // --- melody
    const melPanel = h('div', { class: 'panel' });
    melPanel.append(h('div', { class: 'row head' },
      h('h3', {}, '🎹 Melody', sec.melodyOn ? '' : h('small', { class: 'warn' }, '  (melody is turned off in this section — tick “Melody” above to hear it)')),
      h('div', { class: 'spacer' }),
      h('label', { class: 'field inline' }, 'Length', selectEl([[16, '1 bar'], [32, '2 bars'], [64, '4 bars'], [128, '8 bars']], sec.melodyLen, v => {
        const L = +v;
        sec.melody = sec.melody.map(row => { const r = new Array(L).fill(0); for (let i = 0; i < Math.min(L, row.length); i++) r[i] = row[i]; if (r[0] === 2) r[0] = 1; return r; });
        sec.melodyLen = L;
        this.commit();
      })),
      h('label', { class: 'field inline' }, 'Copy from', selectEl([['', 'Section…'], ...p.sections.filter(s => s !== sec).map(s => [s.id, s.name])], '', v => {
        const src = this.secById(v);
        if (src) { sec.melody = JSON.parse(JSON.stringify(src.melody)); sec.melodyLen = src.melodyLen; sec.melodyOn = true; this.commit(); }
      })),
      h('button', { onclick: () => { sec.melody = Presets.emptyMelody(sec.melodyLen); this.commit(); } }, 'Clear')
    ));
    const mg = h('div', { class: 'mel-grid' + (sec.melodyOn ? '' : ' off'), style: { '--cols': sec.melodyLen } });
    this.melCols = Array.from({ length: sec.melodyLen }, () => []);
    const melCls = (v, i) => 'mcell' + (v === 1 ? ' on' : v === 2 ? ' tie' : '') + (i % 16 === 0 ? ' bar' : i % 4 === 0 ? ' beat' : '');
    const rowsEls = [];
    const refreshRow = r => rowsEls[r].forEach((c, i) => { c.className = melCls(sec.melody[r][i], i); });
    for (let r = Presets.MEL_ROWS - 1; r >= 0; r--) {
      const midi = Theory.degreeMidi(p.key, p.scale, r);
      const sc = Theory.SCALES[p.scale] || Theory.SCALES.major;
      const isRoot = r % sc.length === 0;
      const row = h('div', { class: 'mrow' + (isRoot ? ' root' : '') });
      row.append(h('button', { class: 'mname', onclick: () => this.previewNote('melody', p.inst.melody, midi) }, Theory.noteName(midi)));
      rowsEls[r] = [];
      for (let i = 0; i < sec.melodyLen; i++) {
        const c = h('div', { class: melCls(sec.melody[r][i], i) });
        c.addEventListener('pointerdown', e => {
          if (e.button !== 0) return;
          e.preventDefault();
          const m = sec.melody[r];
          if (m[i]) {
            let s = i;
            while (s > 0 && m[s] === 2) s--;
            m[s] = 0;
            for (let j = s + 1; j < m.length && m[j] === 2; j++) m[j] = 0;
            refreshRow(r);
            this.commit({ render: false });
          } else {
            m[i] = 1;
            this.melPaint = { r, last: i, sec };
            refreshRow(r);
            this.previewNote('melody', p.inst.melody, midi, 0.3);
          }
        });
        c.addEventListener('pointerenter', e => {
          const mp = this.melPaint;
          if (!mp || mp.sec !== sec || mp.r !== r || !(e.buttons & 1) || i <= mp.last) return;
          const m = sec.melody[r];
          for (let x = mp.last + 1; x <= i; x++) { if (m[x] === 1) break; m[x] = 2; mp.last = x; }
          refreshRow(r);
        });
        rowsEls[r].push(c);
        this.melCols[i].push(c);
        row.append(c);
      }
      mg.append(row);
    }
    melPanel.append(h('div', { class: 'mel-scroll' }, mg),
      h('p', { class: 'hint' }, `Notes follow the song key (${Theory.NOTES[p.key]} ${Theory.SCALE_NAMES[p.scale]}), so every note fits. Click = add note · Drag right = longer note · Click a note = delete`));
    root.append(melPanel);
  },

  // ===================== ARRANGE & RECORD =====================
  renderArrange() {
    const p = this.p;
    const root = $('#tab-arrange');
    const prevScroll = this.tlEl ? { l: this.tlEl.scrollLeft, t: this.tlEl.scrollTop } : null;
    root.innerHTML = '';
    const sd = Engine.stepDur(p);
    const map = Engine.songMap(p);

    // --- toolbar
    root.append(h('div', { class: 'toolbar' },
      h('button', { class: 'primary', onclick: () => this.addTrack() }, '+ Track'),
      h('button', { onclick: () => $('#fileAudio').click() }, '📂 Import audio'),
      h('span', { class: 'sep' }),
      h('button', { onclick: () => this.splitClip(), title: 'S' }, '✂ Split'),
      h('button', { onclick: () => this.duplicateClip(), title: 'Ctrl+D' }, '⧉ Duplicate'),
      h('button', { onclick: () => this.deleteClip(), title: 'Delete' }, '🗑 Delete'),
      h('span', { class: 'sep' }),
      h('label', { class: 'field inline' }, 'Snap', selectEl(SNAP_NAMES, this.snap, v => { this.snap = v; })),
      h('label', { class: 'field inline' }, 'Zoom', h('input', {
        type: 'range', min: 8, max: 300, step: 1, value: this.zoom,
        oninput: e => { this.zoom = +e.target.value; clearTimeout(this.zoomT); this.zoomT = setTimeout(() => this.renderArrange(), 30); }
      })),
      h('span', { class: 'sep' }),
      h('label', { class: 'pill', title: 'New takes replace whatever was recorded underneath (punch-in)' },
        h('input', { type: 'checkbox', checked: this.replaceMode, onchange: e => { this.replaceMode = e.target.checked; } }), 'Replace (punch-in)'),
      h('label', { class: 'pill', title: 'Hear your microphone through your headphones while recording' },
        h('input', {
          type: 'checkbox', checked: this.monitor, onchange: async e => {
            this.monitor = e.target.checked;
            try { this.audio(); await this.rec.init(this.player.ctx); this.rec.setMonitor(this.monitor); } catch (err) { toast('Microphone not available'); }
          }
        }), 'Hear mic'),
      h('label', { class: 'field inline', title: 'If takes land late, raise this; if early, lower it' }, 'Latency',
        h('input', {
          id: 'latency', type: 'number', min: 0, max: 500, step: 1, value: this.latencyMs ?? '', placeholder: 'auto', style: { width: '58px' },
          onchange: e => { this.latencyMs = clamp(+e.target.value || 0, 0, 500); try { localStorage.setItem('beats-latency', this.latencyMs); } catch (er) { /* ignore */ } }
        }), 'ms'),
      h('span', { class: 'lbl' }, 'Mic'), h('canvas', { id: 'inMeter', width: 70, height: 10, class: 'meter' })
    ));

    // --- arrangement editor
    const addSel = selectEl(p.sections.map(s => [s.id, s.name]), p.sections[0].id, () => { });
    const selId = p.arrangement[this.selArr];
    root.append(h('div', { class: 'arr-editor' },
      h('span', { class: 'lbl' }, 'Song structure'),
      h('div', { class: 'arr-chips' }, p.arrangement.map((id, i) => {
        const s = this.secById(id);
        return h('button', {
          class: 'arr-chip' + (i === this.selArr ? ' sel' : ''), style: { '--hue': this.sectionHue(s) },
          onclick: () => { this.selArr = i; this.seek(this.arrStart(i)); this.renderArrange(); }
        }, h('b', {}, s.name), h('small', {}, s.bars + ' bars'));
      })),
      h('div', { class: 'arr-actions' },
        addSel,
        h('button', { onclick: () => { const at = this.selArr >= 0 ? this.selArr + 1 : p.arrangement.length; p.arrangement.splice(at, 0, addSel.value); this.selArr = at; this.commit(); } }, '+ Add'),
        selId ? [
          h('button', { title: 'Move earlier', onclick: () => this.moveArr(-1) }, '◀'),
          h('button', { title: 'Move later', onclick: () => this.moveArr(1) }, '▶'),
          h('button', { title: 'Remove from song', onclick: () => { if (p.arrangement.length < 2) return toast('The song needs at least one section'); p.arrangement.splice(this.selArr, 1); this.selArr = -1; this.commit(); } }, '✕'),
          h('button', { title: 'Make this copy independent so you can change it without affecting the others', onclick: () => this.makeUnique() }, 'Make unique'),
          h('button', { onclick: () => { this.selSection = selId; this.setTab('beat'); } }, 'Edit beat →')
        ] : h('span', { class: 'muted small' }, 'Click a section to move, remove or edit it')
      )
    ));

    // --- timeline
    const total = Math.max(Engine.songLength(p), map.total * sd) + 30;
    const W = Math.ceil(total * this.zoom);
    const tl = h('div', { class: 'timeline' });
    const inner = h('div', { class: 'tl-inner', style: { width: (W + HEADER_W) + 'px' } });
    tl.append(inner);

    // ruler
    const bd = sd * 16;
    const nBars = Math.ceil(total / bd);
    const every = [1, 2, 4, 8, 16, 32].find(k => k * bd * this.zoom >= 34) || 64;
    const ruler = h('div', { class: 'tl-lane ruler', style: { width: W + 'px' } });
    for (let b = 0; b < nBars; b++) {
      if (b % every === 0) ruler.append(h('div', { class: 'tick bar', style: { left: (b * bd * this.zoom) + 'px' } }, String(b + 1)));
      else if (every <= 2) ruler.append(h('div', { class: 'tick minor', style: { left: (b * bd * this.zoom) + 'px' } }));
    }
    ruler.addEventListener('pointerdown', e => this.seek(this.snapTime((e.clientX - ruler.getBoundingClientRect().left) / this.zoom, e)));
    inner.append(h('div', { class: 'tl-row ruler-row' }, h('div', { class: 'tl-head' }, h('span', { class: 'muted small' }, 'Bars')), ruler));

    // structure lane
    const secLane = h('div', { class: 'tl-lane secs', style: { width: W + 'px' } });
    map.items.forEach(it => {
      secLane.append(h('div', {
        class: 'secblock' + (it.index === this.selArr ? ' sel' : ''), style: { left: (it.start * sd * this.zoom) + 'px', width: (it.steps * sd * this.zoom) + 'px', '--hue': this.sectionHue(it.sec) },
        title: it.sec.name, onpointerdown: e => { e.stopPropagation(); this.selArr = it.index; this.seek(it.start * sd); this.renderArrange(); }
      }, it.sec.name));
    });
    inner.append(h('div', { class: 'tl-row sec-row' }, h('div', { class: 'tl-head' }, h('b', {}, 'Beat'), h('span', { class: 'muted small' }, ' (song structure)')), secLane));

    // tracks
    p.tracks.forEach((t, ti) => {
      const head = h('div', {
        class: 'tl-head track-head' + (t.id === this.selTrack ? ' sel' : ''), style: { '--hue': this.trackHue(ti) },
        onpointerdown: e => { if (e.target.closest('input,button')) return; this.selTrack = t.id; this.selClip = null; this.renderArrange(); }
      },
        h('div', { class: 'th-top' },
          h('input', { class: 'tname', value: t.name, onchange: e => { t.name = e.target.value || 'Track'; this.commit(); } }),
          h('button', { class: 'xbtn', title: 'Delete track', onclick: () => this.deleteTrack(t) }, '✕')),
        h('div', { class: 'th-btns' },
          h('button', { class: 'tb arm' + (t.armed ? ' on' : ''), title: 'Arm for recording', onclick: () => { this.p.tracks.forEach(x => { x.armed = x === t ? !x.armed : false; }); this.selTrack = t.id; this.commit(); } }, '●'),
          h('button', { class: 'tb m' + (t.cfg.mute ? ' on' : ''), title: 'Mute', onclick: () => { t.cfg.mute = !t.cfg.mute; this.commit(); } }, 'M'),
          h('button', { class: 'tb s' + (t.cfg.solo ? ' on' : ''), title: 'Solo', onclick: () => { t.cfg.solo = !t.cfg.solo; this.commit(); } }, 'S'),
          h('input', { type: 'range', class: 'tvol', min: 0, max: 1, step: 0.01, value: t.cfg.vol, title: 'Volume', oninput: e => { t.cfg.vol = +e.target.value; this.live(); }, onchange: () => this.commit({ render: false }) })
        ));
      const lane = h('div', { class: 'tl-lane track-lane' + (t.id === this.selTrack ? ' sel' : ''), dataset: { track: t.id }, style: { width: W + 'px', '--hue': this.trackHue(ti) } });
      lane.addEventListener('pointerdown', e => {
        if (e.target !== lane) return;
        this.selTrack = t.id;
        this.selClip = null;
        this.seek(this.snapTime((e.clientX - lane.getBoundingClientRect().left) / this.zoom, e));
        this.renderArrange();
      });
      t.clips.slice().sort((a, b) => a.start - b.start).forEach(c => lane.append(this.clipEl(t, c, ti)));
      if (this.recording && t.id === this.recTrack) {
        this.recEl = h('div', { class: 'rec-block', style: { left: (this.recFrom * this.zoom) + 'px' } }, '● REC');
        lane.append(this.recEl);
      }
      inner.append(h('div', { class: 'tl-row track-row' }, head, lane));
    });
    if (!p.tracks.length) {
      inner.append(h('div', { class: 'tl-row empty-row' }, h('div', { class: 'tl-head' }),
        h('div', { class: 'tl-lane empty', style: { width: W + 'px' } }, 'No vocal tracks yet. Press ● Record to record (a track is created automatically), or click “+ Track” / “Import audio”.')));
    }

    this.playheadEl = h('div', { class: 'playhead' });
    inner.append(this.playheadEl);
    root.append(tl);
    this.tlEl = tl;
    if (prevScroll) { tl.scrollLeft = prevScroll.l; tl.scrollTop = prevScroll.t; }

    // --- inspector
    this.inspectorEl = h('div', { class: 'inspector' });
    root.append(this.inspectorEl);
    this.renderInspector();
  },

  moveArr(d) {
    const a = this.p.arrangement, i = this.selArr, j = i + d;
    if (i < 0 || j < 0 || j >= a.length) return;
    [a[i], a[j]] = [a[j], a[i]];
    this.selArr = j;
    this.commit();
  },
  makeUnique() {
    const id = this.p.arrangement[this.selArr];
    const sec = this.secById(id);
    if (!sec) return;
    const s = JSON.parse(JSON.stringify(sec));
    s.id = Presets.uid('s_');
    s.name = sec.name + ' ' + (this.p.sections.filter(x => x.name.startsWith(sec.name)).length + 1);
    this.p.sections.push(s);
    this.p.arrangement[this.selArr] = s.id;
    this.commit();
    toast(`This spot now uses “${s.name}”. Edits to it won't change the other “${sec.name}” sections.`, 4000);
  },

  clipEl(track, clip, ti) {
    const el = h('div', { class: 'clip' + (clip.id === this.selClip ? ' sel' : ''), dataset: { clip: clip.id }, style: { '--hue': this.trackHue(ti) } },
      h('div', { class: 'clip-name' }, clip.name || 'Clip'),
      h('canvas', { class: 'wave', height: 48 }),
      h('div', { class: 'hd trim-l', dataset: { h: 'l' }, title: 'Drag to trim start' }),
      h('div', { class: 'hd trim-r', dataset: { h: 'r' }, title: 'Drag to trim end' }),
      h('div', { class: 'hd fade fi', dataset: { h: 'fi' }, title: 'Drag to fade in' }),
      h('div', { class: 'hd fade fo', dataset: { h: 'fo' }, title: 'Drag to fade out' }));
    el.addEventListener('pointerdown', e => this.clipDown(e, track, clip, el));
    this.layoutClip(el, clip);
    return el;
  },
  layoutClip(el, clip) {
    const z = this.zoom;
    el.style.left = (clip.start * z) + 'px';
    el.style.width = Math.max(4, clip.duration * z) + 'px';
    el.querySelector('.fi').style.left = ((clip.fadeIn || 0) * z) + 'px';
    el.querySelector('.fo').style.right = ((clip.fadeOut || 0) * z) + 'px';
    this.drawClip(el.querySelector('canvas'), clip);
  },
  drawClip(cv, clip) {
    const W = Math.max(1, Math.min(Math.round(clip.duration * this.zoom), 8000));
    const H = 48;
    cv.width = W;
    cv.height = H;
    const g = cv.getContext('2d');
    g.clearRect(0, 0, W, H);
    const buf = this.buffers.get(clip.bufferId);
    if (!buf) { g.fillStyle = 'rgba(255,255,255,.4)'; g.fillText('audio missing', 4, 28); return; }
    const pk = Engine.peaks(buf);
    const spp = clip.duration / W;
    g.fillStyle = 'rgba(255,255,255,.85)';
    for (let x = 0; x < W; x++) {
      const t0 = clip.offset + x * spp;
      const i0 = Math.floor(t0 * pk.rate);
      const i1 = Math.max(i0 + 1, Math.floor((t0 + spp) * pk.rate));
      let mn = 0, mx = 0;
      for (let i = i0; i < i1 && i < pk.max.length; i++) { if (pk.max[i] > mx) mx = pk.max[i]; if (pk.min[i] < mn) mn = pk.min[i]; }
      const env = Math.min(1.5, (clip.gain ?? 1) * Engine.clipEnvelope(clip, x * spp));
      const top = H / 2 - mx * env * H / 2;
      g.fillRect(x, top, 1, Math.max(1, (mx - mn) * env * H / 2));
    }
    const fiW = (clip.fadeIn || 0) / spp, foW = (clip.fadeOut || 0) / spp;
    g.fillStyle = 'rgba(0,0,0,.35)';
    if (fiW > 1) { g.beginPath(); g.moveTo(0, 0); g.lineTo(fiW, 0); g.lineTo(0, H); g.fill(); }
    if (foW > 1) { g.beginPath(); g.moveTo(W, 0); g.lineTo(W - foW, 0); g.lineTo(W, H); g.fill(); }
  },
  clipDown(e, track, clip, el) {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const mode = e.target.dataset.h || 'move';
    if (this.selClip !== clip.id || this.selTrack !== track.id) {
      this.selClip = clip.id;
      this.selTrack = track.id;
      document.querySelectorAll('.clip.sel').forEach(x => x.classList.remove('sel'));
      el.classList.add('sel');
      document.querySelectorAll('.track-head, .track-lane').forEach(x => x.classList.remove('sel'));
      this.renderInspector();
    }
    const buf = this.buffers.get(clip.bufferId);
    const bufDur = buf ? buf.duration : clip.offset + clip.duration;
    const x0 = e.clientX, y0 = e.clientY;
    const o = Object.assign({ fadeIn: 0, fadeOut: 0 }, clip);
    let moved = false;
    let cur = track;
    const move = ev => {
      if (!moved && Math.abs(ev.clientX - x0) < 3 && Math.abs(ev.clientY - y0) < 3) return;
      moved = true;
      const dx = (ev.clientX - x0) / this.zoom;
      if (mode === 'move') {
        clip.start = Math.max(0, this.snapTime(o.start + dx, ev));
        const lane = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.track-lane');
        if (lane && lane.dataset.track !== cur.id) {
          const nt = this.p.tracks.find(t => t.id === lane.dataset.track);
          if (nt) {
            cur.clips = cur.clips.filter(c => c !== clip);
            nt.clips.push(clip);
            cur = nt;
            this.selTrack = nt.id;
            lane.append(el);
            el.style.setProperty('--hue', lane.style.getPropertyValue('--hue'));
          }
        }
      } else if (mode === 'l') {
        let ns = this.snapTime(o.start + dx, ev);
        ns = clamp(ns, Math.max(0, o.start - o.offset), o.start + o.duration - 0.05);
        const d = ns - o.start;
        clip.start = ns; clip.offset = o.offset + d; clip.duration = o.duration - d;
        clip.fadeIn = Math.min(o.fadeIn, clip.duration);
      } else if (mode === 'r') {
        let ne = this.snapTime(o.start + o.duration + dx, ev);
        ne = clamp(ne, o.start + 0.05, o.start + bufDur - o.offset);
        clip.duration = ne - o.start;
        clip.fadeOut = Math.min(o.fadeOut, clip.duration);
      } else if (mode === 'fi') {
        clip.fadeIn = clamp(o.fadeIn + dx, 0, clip.duration - (clip.fadeOut || 0));
      } else if (mode === 'fo') {
        clip.fadeOut = clamp(o.fadeOut - dx, 0, clip.duration - (clip.fadeIn || 0));
      }
      this.layoutClip(el, clip);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (moved) this.commit();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  },

  renderInspector() {
    const box = this.inspectorEl;
    if (!box) return;
    box.innerHTML = '';
    const sel = this.selected();
    if (sel) {
      const c = sel.clip;
      const maxFade = Math.min(10, c.duration);
      box.append(h('div', { class: 'panel insp' },
        h('h3', {}, '🎵 Clip'),
        h('label', { class: 'field' }, 'Name', h('input', { value: c.name || '', onchange: e => { c.name = e.target.value; this.commit(); } })),
        h('div', { class: 'muted small' }, `Starts at bar ${this.fmtBars(c.start)} (${this.fmtTime(c.start)}) · length ${c.duration.toFixed(2)} s`),
        sliderEl('Clip volume', +toDB(c.gain ?? 1).toFixed(1), -24, 24, 0.5, v => (v > 0 ? '+' : '') + v.toFixed(1) + ' dB', v => { c.gain = fromDB(v); }, () => this.commit()),
        sliderEl('Fade in', c.fadeIn || 0, 0, maxFade, 0.01, v => v.toFixed(2) + ' s', v => { c.fadeIn = Math.min(v, c.duration - (c.fadeOut || 0)); }, () => this.commit()),
        sliderEl('Fade out', c.fadeOut || 0, 0, maxFade, 0.01, v => v.toFixed(2) + ' s', v => { c.fadeOut = Math.min(v, c.duration - (c.fadeIn || 0)); }, () => this.commit()),
        h('div', { class: 'row' },
          h('button', { onclick: () => this.normalizeClip(), title: 'Make the clip as loud as possible without clipping' }, 'Normalize'),
          h('button', { onclick: () => this.reverseClip() }, 'Reverse'),
          h('button', { onclick: () => this.splitClip() }, '✂ Split at playhead'),
          h('button', { onclick: () => this.duplicateClip() }, '⧉ Duplicate'),
          h('button', { class: 'danger', onclick: () => this.deleteClip() }, '🗑 Delete'))
      ));
    }
    const tr = this.p.tracks.find(t => t.id === this.selTrack);
    if (tr) {
      box.append(h('div', { class: 'panel insp grow' },
        h('h3', {}, '🎚️ Track effects — ', tr.name),
        h('div', { class: 'presets' }, h('span', { class: 'lbl' }, 'Vocal presets:'),
          Object.entries(VOCAL_PRESETS).map(([n, v]) => h('button', { onclick: () => { Object.assign(tr.cfg, v); this.commit(); toast('Applied “' + n + '”'); } }, n))),
        this.channelControls(tr.cfg, true)
      ));
    }
    if (!sel && !tr) box.append(h('div', { class: 'panel insp muted' }, 'Select a track or clip to edit it here.'));
  },

  // ===================== MIXER =====================
  channelControls(cfg, full) {
    const live = () => this.live();
    const done = () => this.commit({ render: false });
    const db = v => { const d = toDB(v * v * 2); return (d > 0 ? '+' : '') + (v === 0 ? '-∞' : d.toFixed(1)) + ' dB'; };
    const eq = v => (v > 0 ? '+' : '') + v + ' dB';
    const pct = v => Math.round(v * 100) + '%';
    const wrap = h('div', { class: 'controls' },
      sliderEl('Volume', cfg.vol, 0, 1, 0.01, db, v => { cfg.vol = v; live(); }, done),
      sliderEl('Pan', cfg.pan, -1, 1, 0.05, v => v === 0 ? 'C' : (v < 0 ? 'L' : 'R') + Math.round(Math.abs(v) * 100), v => { cfg.pan = v; live(); }, done),
      sliderEl('Reverb', cfg.reverb, 0, 1, 0.01, pct, v => { cfg.reverb = v; live(); }, done),
      sliderEl('Echo', cfg.delay, 0, 1, 0.01, pct, v => { cfg.delay = v; live(); }, done)
    );
    if (full) {
      wrap.append(
        sliderEl('Bass EQ', cfg.low, -12, 12, 1, eq, v => { cfg.low = v; live(); }, done),
        sliderEl('Mid EQ', cfg.mid, -12, 12, 1, eq, v => { cfg.mid = v; live(); }, done),
        sliderEl('Treble EQ', cfg.high, -12, 12, 1, eq, v => { cfg.high = v; live(); }, done),
        sliderEl('Compress', cfg.comp, 0, 1, 0.01, pct, v => { cfg.comp = v; live(); }, done),
        h('label', { class: 'pill' + (cfg.hp ? ' on' : ''), title: 'Removes low rumble (mic stand bumps, air conditioning, breath pops)' },
          h('input', { type: 'checkbox', checked: cfg.hp, onchange: e => { cfg.hp = e.target.checked; this.commit(); } }), 'Low-cut (remove rumble)')
      );
    }
    return wrap;
  },

  renderMixer() {
    const p = this.p;
    const root = $('#tab-mixer');
    root.innerHTML = '';
    const strip = (name, cfg, hue, extra) => h('div', { class: 'strip', style: { '--hue': hue } },
      h('div', { class: 'strip-head' }, h('b', {}, name),
        h('div', { class: 'th-btns' },
          h('button', { class: 'tb m' + (cfg.mute ? ' on' : ''), onclick: () => { cfg.mute = !cfg.mute; this.commit(); } }, 'M'),
          h('button', { class: 'tb s' + (cfg.solo ? ' on' : ''), onclick: () => { cfg.solo = !cfg.solo; this.commit(); } }, 'S'))),
      extra || null,
      this.channelControls(cfg, true));
    root.append(h('div', { class: 'mixer' },
      h('div', { class: 'mix-group' }, h('h3', {}, 'Beat'), h('div', { class: 'strips' },
        Engine.BEAT_CHANNELS.map((c, i) => strip(CHANNEL_NAMES[c], p.mix[c], (i * 40 + 190) % 360)))),
      h('div', { class: 'mix-group' }, h('h3', {}, 'Vocals & recordings'), h('div', { class: 'strips' },
        p.tracks.length ? p.tracks.map((t, i) => strip(t.name, t.cfg, this.trackHue(i),
          h('select', {
            class: 'preset-sel', onchange: e => { if (e.target.value) { Object.assign(t.cfg, VOCAL_PRESETS[e.target.value]); this.commit(); } }
          }, h('option', { value: '' }, 'Vocal preset…'), Object.keys(VOCAL_PRESETS).map(n => h('option', { value: n }, n)))))
          : h('p', { class: 'muted' }, 'No recordings yet — record in “Arrange & Record”.'))),
      h('div', { class: 'mix-group master' }, h('h3', {}, 'Master'),
        h('div', { class: 'strip master-strip' },
          sliderEl('Master volume', p.master.vol, 0, 1.2, 0.01, v => toDB(v).toFixed(1) + ' dB', v => { p.master.vol = v; this.live(); }, () => this.commit({ render: false })),
          h('label', { class: 'pill' + (p.master.glue ? ' on' : ''), title: 'Gentle bus compression that glues the mix together' },
            h('input', { type: 'checkbox', checked: p.master.glue, onchange: e => { p.master.glue = e.target.checked; this.commit(); } }), 'Glue compressor'),
          sliderEl('Loudness', p.master.loud, 0, 12, 0.5, v => '+' + v.toFixed(1) + ' dB', v => { p.master.loud = v; this.live(); }, () => this.commit({ render: false })),
          h('p', { class: 'hint' }, 'A limiter is always on, so the song never clips. Raise Loudness until the song sounds full. Stop before it starts to sound squashed.'),
          h('canvas', { id: 'meter2', width: 220, height: 16, class: 'meter big' }),
          h('button', { class: 'primary big', onclick: () => { $('#exportStatus').textContent = ''; $('#dlgExport').showModal(); } }, '⬇ Export song (WAV)')))
    ));
  },

  // ===================== files =====================
  buildGenreDialog() {
    const grid = $('#genreGrid');
    Presets.GENRES.forEach(g => grid.append(h('button', {
      class: 'genre-card', onclick: () => {
        $('#dlgNew').close();
        const hasWork = this.p && this.p.tracks.some(t => t.clips.length) && !this.firstRun;
        if (hasWork && !confirm('Start a new song? The current song will be replaced. Use Save first if you want to keep it.')) return;
        this.firstRun = false;
        this.setProject(g.build());
        this.loopMode = true;
        this.setTab('beat');
        toast(`${g.name} song ready. Press Space or ▶ to hear it.`, 3500);
      }
    }, h('span', { class: 'gicon' }, g.icon), h('b', {}, g.name), h('small', {}, g.desc))));
  },
  openNewDialog(first) {
    this.firstRun = !!first;
    $('#dlgNew').showModal();
  },
  async saveFile() {
    try {
      toast('Preparing project file…');
      const blob = await Store.exportFile(this.p, this.buffers);
      download(blob, (this.p.name || 'song').replace(/[^\w\- ]+/g, '').trim() + '.beats');
      toast('Project saved ✓');
    } catch (e) { toast('Save failed: ' + e.message, 5000); }
  },
  async openFile(file) {
    try {
      const ctx = this.audio();
      const { project, buffers } = await Store.importFile(file, ctx);
      for (const [id, b] of buffers) { this.buffers.set(id, b); Store.saveBuffer(id, b).catch(() => { }); }
      this.setProject(project);
      toast('Opened “' + project.name + '”');
    } catch (e) { toast('Could not open file: ' + e.message, 5000); }
  },
  async exportAudio(kind) {
    const st = $('#exportStatus');
    if (kind === 'vocals' && !this.p.tracks.some(t => t.clips.length)) { st.textContent = 'There are no recordings to export yet.'; return; }
    st.textContent = 'Rendering… this can take a few seconds for a long song.';
    document.querySelectorAll('[data-export]').forEach(b => { b.disabled = true; });
    try {
      await new Promise(r => setTimeout(r, 30));
      const sampleRate = this.player.ctx ? this.player.ctx.sampleRate : 44100;
      const buf = await Engine.render(this.p, this.buffers, { instrumental: kind === 'instrumental', vocalsOnly: kind === 'vocals', sampleRate });
      const suffix = { full: '', instrumental: ' (Instrumental)', vocals: ' (Vocals)' }[kind];
      download(Engine.wav(buf), (this.p.name || 'song').replace(/[^\w\- ]+/g, '').trim() + suffix + '.wav');
      st.textContent = `Done ✓ — ${this.fmtTime(buf.duration)} exported. Check your Downloads folder.`;
    } catch (e) {
      console.error(e);
      st.textContent = 'Export failed: ' + e.message;
    }
    document.querySelectorAll('[data-export]').forEach(b => { b.disabled = false; });
  },

  // ===================== keyboard =====================
  bindKeys() {
    document.addEventListener('keydown', e => {
      if (document.querySelector('dialog[open]')) return;
      const t = e.target;
      const typing = (t.tagName === 'INPUT' && !['range', 'checkbox', 'button'].includes(t.type)) || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT';
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); this.saveFile(); return; }
      if (typing) return;
      if (mod) {
        const k = e.key.toLowerCase();
        if (k === 'z' && !e.shiftKey) { e.preventDefault(); this.doUndo(); }
        else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); this.doRedo(); }
        else if (k === 'd') { e.preventDefault(); this.duplicateClip(); }
        return;
      }
      switch (e.code) {
        case 'Space': e.preventDefault(); if (t.blur) t.blur(); this.togglePlay(); break;
        case 'KeyR': this.toggleRecord(); break;
        case 'KeyS': this.splitClip(); break;
        case 'KeyL': this.setLoopMode(!this.loopMode); break;
        case 'Delete': case 'Backspace': if (this.selClip) { e.preventDefault(); this.deleteClip(); } break;
        case 'Home': this.seek(0); break;
      }
    });
  },

  // ===================== animation frame =====================
  drawMeter(cv, level) {
    if (!cv) return;
    const g = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(255,255,255,.08)';
    g.fillRect(0, 0, W, H);
    const db = toDB(level);
    const x = clamp((db + 48) / 48, 0, 1) * W;
    const grad = g.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0, '#2fbf71'); grad.addColorStop(0.75, '#e6c229'); grad.addColorStop(1, '#ff4d4d');
    g.fillStyle = grad;
    g.fillRect(0, 0, x, H);
  },
  frame() {
    requestAnimationFrame(() => this.frame());
    const pl = this.player;
    const info = pl.playing ? pl.position() : null;
    let pos = this.playhead;
    if (info && !info.loop) pos = info.pos;
    if (info && info.loop) { $('#timePos').textContent = this.fmtBars(info.pos); $('#timeSec').textContent = 'loop ' + this.fmtTime(info.pos); }
    else { $('#timePos').textContent = this.fmtBars(pos); $('#timeSec').textContent = this.fmtTime(pos); }

    if (this.tab === 'arrange' && this.playheadEl) {
      const x = HEADER_W + Math.max(0, pos) * this.zoom;
      this.playheadEl.style.left = x + 'px';
      this.playheadEl.classList.toggle('hidden', !!(info && info.loop));
      if (info && !info.loop && this.tlEl) {
        const tl = this.tlEl;
        if (x > tl.scrollLeft + tl.clientWidth - 40 || x < tl.scrollLeft + HEADER_W) tl.scrollLeft = Math.max(0, x - HEADER_W - 80);
      }
      if (this.recording && this.recEl) this.recEl.style.width = Math.max(0, (pos - this.recFrom) * this.zoom) + 'px';
    }

    if (this.tab === 'beat' && this.drumCells) {
      const sec = this.curSection();
      let st = -1, ms = -1;
      if (info && info.secId === sec.id && info.sIdx >= 0) { st = info.sIdx % 16; ms = info.sIdx % sec.melodyLen; }
      if (st !== this.hlStep) {
        if (this.hlStep >= 0 && this.drumCells[this.hlStep]) this.drumCells[this.hlStep].forEach(c => c.classList.remove('now'));
        if (st >= 0) this.drumCells[st].forEach(c => c.classList.add('now'));
        this.hlStep = st;
      }
      if (ms !== this.hlMel && this.melCols) {
        if (this.hlMel >= 0 && this.melCols[this.hlMel]) this.melCols[this.hlMel].forEach(c => c.classList.remove('now'));
        if (ms >= 0 && this.melCols[ms]) this.melCols[ms].forEach(c => c.classList.add('now'));
        this.hlMel = ms;
      }
    }

    if (pl.ctx && pl.mixer.analyser) {
      const a = this.meterBuf || (this.meterBuf = new Float32Array(pl.mixer.analyser.fftSize));
      pl.mixer.analyser.getFloatTimeDomainData(a);
      let pk = 0;
      for (let i = 0; i < a.length; i++) pk = Math.max(pk, Math.abs(a[i]));
      this.meterLevel = Math.max(pk, (this.meterLevel || 0) * 0.92);
      this.drawMeter($('#meter'), this.meterLevel);
      if (this.tab === 'mixer') this.drawMeter($('#meter2'), this.meterLevel);
    }
    if (this.tab === 'arrange' && this.rec.ready) {
      this.inLevel = Math.max(this.rec.level(), (this.inLevel || 0) * 0.9);
      this.drawMeter($('#inMeter'), this.inLevel);
    }
  }
};

window.addEventListener('DOMContentLoaded', () => App.init());
