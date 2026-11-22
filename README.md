# Beats Studio

A music studio that runs in your web browser. You can make beats in any genre, record your voice on top, edit the takes, mix and master, and export a finished song as a WAV file. Every instrument and drum is generated in code, so there are no sample files to download.

## Run it

```
npm start
```

This opens **http://localhost:4800** in your browser. If something else is already using that port, it moves to the next free one and prints the address. Chrome or Edge is recommended. No install step is needed; it only uses Node's built-in modules.

> Browsers only allow microphone recording on `http://localhost` or `https`, so use `npm start`. Opening `index.html` by double-clicking won't reliably allow recording.

## What it does

| Area | Features |
|---|---|
| **Genres** | Worship, Rap/Trap, Hip-Hop (Boom Bap), Jazz, Classical, Gospel, Pop, Afrobeats, R&B, or start from scratch. Each one is a full song: intro, verse, chorus, bridge… |
| **Beat Maker** | 8-sound drum grid with ghost notes, hi-hat rolls and paint-drag. 15 ready grooves. Chords written as Roman numerals (`I \| V \| vi \| IV`, `ii7 V7`) or plain names (`Am \| F`), plus 16 preset progressions. 8 keyboard styles (arpeggio, jazz comping, off-beat stabs…). 7 bass styles (walking bass, 808 that follows the kick…). Scale-locked melody grid. 5 drum kits and 16 instruments. Key, scale, tempo and swing. |
| **Arrange** | Song structure editor. Sections can be reused, reordered, or made unique. |
| **Record** | Multitrack microphone recording with count-in, metronome, latency compensation, punch-in replace, mic monitoring and an input meter. You can also import audio files. |
| **Edit** | Move clips (also onto other tracks), trim, fade in/out, split, duplicate, delete, normalize, reverse, clip volume. Snap to bar, beat or 1/16. Undo/redo. |
| **Mix & master** | Per channel: volume, pan, low-cut, 3-band EQ, compressor, reverb, echo, mute and solo. One-click vocal presets: Clean, Rap, Worship, Choir, Radio. On the master: glue compressor, loudness, and an always-on limiter with a safety clipper. |
| **Export / save** | Export the full song, the instrumental only, or the vocals only, as WAV. The project autosaves in the browser. **Save** writes a `.beats` file with recordings included, which you can open on any computer. |

The **How to use** tab inside the app walks through making a full song step by step and lists the keyboard shortcuts.

## Code layout

- `js/synth.js` – drum kits, instruments, and a sample cache. Each distinct sound is synthesized once and then played back cheaply.
- `js/presets.js` – music theory (chords, scales, voicing), genre presets, grooves and progressions.
- `js/engine.js` – mixer, step scheduler, live player, offline export and WAV encoder.
- `js/recorder.js` – microphone capture via AudioWorklet.
- `js/store.js` – IndexedDB autosave and `.beats` project files.
- `js/ui.js` – the application UI.
