'use strict';
/*
 * Store — autosaves the project and recorded audio in the browser (IndexedDB),
 * and saves/opens portable .beats project files.
 */
const Store = (() => {
  let dbp = null;
  function db() {
    if (!dbp) {
      dbp = new Promise((res, rej) => {
        const r = indexedDB.open('beats-studio', 1);
        r.onupgradeneeded = () => {
          r.result.createObjectStore('kv');
          r.result.createObjectStore('buffers');
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    }
    return dbp;
  }
  async function tx(storeName, mode, fn) {
    const d = await db();
    return new Promise((res, rej) => {
      const t = d.transaction(storeName, mode);
      const req = fn(t.objectStore(storeName));
      t.oncomplete = () => res(req ? req.result : undefined);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  }

  const saveProject = p => tx('kv', 'readwrite', s => s.put(JSON.stringify(p), 'project'));
  async function loadProject() {
    const raw = await tx('kv', 'readonly', s => s.get('project'));
    return raw ? JSON.parse(raw) : null;
  }
  function saveBuffer(id, buf) {
    const data = { sr: buf.sampleRate, ch: [...Array(buf.numberOfChannels)].map((_, i) => new Float32Array(buf.getChannelData(i))) };
    return tx('buffers', 'readwrite', s => s.put(data, id));
  }
  async function loadBuffer(id) {
    const d = await tx('buffers', 'readonly', s => s.get(id));
    if (!d) return null;
    const b = new AudioBuffer({ length: d.ch[0].length, numberOfChannels: d.ch.length, sampleRate: d.sr });
    d.ch.forEach((c, i) => b.copyToChannel(c, i));
    return b;
  }
  const bufferKeys = () => tx('buffers', 'readonly', s => s.getAllKeys());
  const deleteBuffer = id => tx('buffers', 'readwrite', s => s.delete(id));

  function blobToDataURL(blob) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = () => rej(r.error);
      r.readAsDataURL(blob);
    });
  }

  // Portable project file: project JSON + every used recording embedded as WAV
  async function exportFile(p, buffers) {
    const used = new Set();
    p.tracks.forEach(t => t.clips.forEach(c => used.add(c.bufferId)));
    const audio = {};
    for (const id of used) {
      const b = buffers.get(id);
      if (b) audio[id] = await blobToDataURL(Engine.wav(b));
    }
    return new Blob([JSON.stringify({ app: 'beats-studio', version: 1, project: p, audio })], { type: 'application/json' });
  }

  async function importFile(file, ctx) {
    const data = JSON.parse(await file.text());
    if (!data.project || !data.project.sections) throw new Error('This is not a Beats Studio project file.');
    const buffers = new Map();
    for (const [id, url] of Object.entries(data.audio || {})) {
      const ab = await (await fetch(url)).arrayBuffer();
      buffers.set(id, await ctx.decodeAudioData(ab));
    }
    return { project: data.project, buffers };
  }

  return { saveProject, loadProject, saveBuffer, loadBuffer, bufferKeys, deleteBuffer, exportFile, importFile };
})();
