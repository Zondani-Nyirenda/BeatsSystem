'use strict';
/*
 * Recorder — captures the microphone as raw, uncompressed audio using an AudioWorklet,
 * timestamped against the audio clock so takes line up with the beat.
 */
class Recorder {
  constructor() { this.ready = false; this.capturing = false; this.chunks = []; }

  async init(ctx) {
    if (this.ready && this.ctx === ctx) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('This browser cannot access a microphone. Use Chrome or Edge, opened via http://localhost.');
    }
    this.ctx = ctx;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    });
    const code = `
      class Capture extends AudioWorkletProcessor {
        constructor() { super(); this.on = false; this.port.onmessage = e => { this.on = e.data; }; }
        process(inputs) {
          const inp = inputs[0];
          if (this.on && inp && inp.length) this.port.postMessage({ t: currentTime, d: inp[0].slice(0) });
          return true;
        }
      }
      registerProcessor('beats-capture', Capture);`;
    const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
    await ctx.audioWorklet.addModule(url);
    this.source = ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(ctx, 'beats-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' });
    this.node.port.onmessage = e => { if (this.capturing) this.chunks.push(e.data); };
    const sink = ctx.createGain();
    sink.gain.value = 0;
    this.source.connect(this.node).connect(sink).connect(ctx.destination);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.source.connect(this.analyser);
    this.monitor = ctx.createGain();
    this.monitor.gain.value = 0;
    this.source.connect(this.monitor).connect(ctx.destination);
    this.ready = true;
  }

  setMonitor(on) { if (this.monitor) this.monitor.gain.value = on ? 1 : 0; }

  level() {
    if (!this.analyser) return 0;
    const a = this.buf || (this.buf = new Float32Array(this.analyser.fftSize));
    this.analyser.getFloatTimeDomainData(a);
    let pk = 0;
    for (let i = 0; i < a.length; i++) pk = Math.max(pk, Math.abs(a[i]));
    return pk;
  }

  start() {
    this.chunks = [];
    this.capturing = true;
    this.node.port.postMessage(true);
  }

  // Returns { buffer: AudioBuffer (mono), startTime: audio-clock time of first sample }
  stop() {
    if (!this.capturing) return null;
    this.capturing = false;
    this.node.port.postMessage(false);
    const chunks = this.chunks;
    this.chunks = [];
    if (!chunks.length) return null;
    const total = chunks.reduce((n, c) => n + c.d.length, 0);
    const buffer = new AudioBuffer({ length: total, numberOfChannels: 1, sampleRate: this.ctx.sampleRate });
    const data = buffer.getChannelData(0);
    let o = 0;
    for (const c of chunks) { data.set(c.d, o); o += c.d.length; }
    return { buffer, startTime: chunks[0].t };
  }
}
