/* =====================================================================
   HEXTRIG · export.js
   Getting music out, ready for a DAW.

   BOUNCE   offline render with an OfflineAudioContext: sample-exact,
            faster than real time. The timing core is deterministic, so
            the mix and each stem pass play exactly the same notes.
            → Mix.wav, Stems/*.wav, MIDI.mid, Read me.txt in one .zip
   CAPTURE  records the live output exactly on the bar lines, with
            everything you do while it runs (sweeps, mutes, fills, knob
            moves, pads), and logs the notes as MIDI. Takes stay in memory.

   Files leave as a single .zip: inside Claude, through the viewer's
   download capability (it allows .zip, not .wav / .mid); anywhere else,
   as a normal browser download.

   The encoders (wav, midi, zip) are pure and tested in tests/run.js.
   ===================================================================== */
(function (HX) {
  'use strict';
  const S = HX.state;
  const X = (HX.exporter = {});

  /* ===================================================================
     Encoders
     =================================================================== */

  // WAV: channels = [Float32Array, …], bits 16 | 24 | 32 (float)
  X.wav = function (channels, sampleRate, bits) {
    const nc = channels.length, n = channels[0].length, bps = bits / 8;
    const dataSize = n * nc * bps;
    const buf = new ArrayBuffer(44 + dataSize);
    const v = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + dataSize, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true);
    v.setUint16(20, bits === 32 ? 3 : 1, true);          // 3 = IEEE float, 1 = PCM
    v.setUint16(22, nc, true); v.setUint32(24, sampleRate, true);
    v.setUint32(28, sampleRate * nc * bps, true); v.setUint16(32, nc * bps, true); v.setUint16(34, bits, true);
    str(36, 'data'); v.setUint32(40, dataSize, true);
    let o = 44;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < nc; c++) {
        let x = channels[c][i];
        if (!(x === x)) x = 0;                              // NaN guard
        if (bits === 32) { v.setFloat32(o, x, true); o += 4; continue; }
        x = Math.max(-1, Math.min(1, x));
        if (bits === 16) {
          const d = (Math.random() - Math.random()) / 32768;   // TPDF dither
          v.setInt16(o, Math.max(-32768, Math.min(32767, Math.round((x + d) * 32767))), true); o += 2;
        } else {
          const s = Math.max(-8388608, Math.min(8388607, Math.round(x * 8388607)));
          v.setUint8(o, s & 255); v.setUint8(o + 1, (s >> 8) & 255); v.setUint8(o + 2, (s >> 16) & 255); o += 3;
        }
      }
    }
    return new Uint8Array(buf);
  };

  // Standard MIDI File, type 1. tracks: [{ name, ch (0-15), notes: [{ pos, len, note, vel }] }]
  // pos and len are in 16ths. 960 ticks per quarter.
  X.midi = function (tracks, bpm, name) {
    const PPQ = 960, T16 = PPQ / 4;
    const bytes = [];
    const u32 = x => [(x >>> 24) & 255, (x >>> 16) & 255, (x >>> 8) & 255, x & 255];
    const vlq = x => { x = Math.max(0, Math.round(x)); const out = [x & 127]; while ((x >>= 7)) out.unshift((x & 127) | 128); return out; };
    const text = (type, s) => { const b = [...new TextEncoder().encode(s)]; return [0xff, type, ...vlq(b.length), ...b]; };
    const chunk = (id, data) => { bytes.push(...[...id].map(c => c.charCodeAt(0)), ...u32(data.length), ...data); };

    chunk('MThd', [0, 1, 0, tracks.length + 1, PPQ >> 8, PPQ & 255]);
    const us = Math.round(60000000 / bpm);
    chunk('MTrk', [0, ...text(3, name || 'HEXTRIG'), 0, 0xff, 0x51, 3, (us >> 16) & 255, (us >> 8) & 255, us & 255,
      0, 0xff, 0x58, 4, 4, 2, 24, 8, 0, 0xff, 0x2f, 0]);
    tracks.forEach(tr => {
      const ev = [];
      tr.notes.forEach(n => {
        const on = Math.max(0, Math.round(n.pos * T16));
        const off = Math.max(on + 1, Math.round((n.pos + n.len) * T16));
        const note = Math.max(0, Math.min(127, Math.round(n.note)));
        const vel = Math.max(1, Math.min(127, Math.round(n.vel * 127)));
        ev.push({ t: on, k: 1, d: [0x90 | tr.ch, note, vel] }, { t: off, k: 0, d: [0x80 | tr.ch, note, 0] });
      });
      ev.sort((a, b) => a.t - b.t || a.k - b.k);           // note-offs before note-ons on the same tick
      const data = [0, ...text(3, tr.name)];
      let last = 0;
      ev.forEach(e => { data.push(...vlq(e.t - last), ...e.d); last = e.t; });
      data.push(0, 0xff, 0x2f, 0);
      chunk('MTrk', data);
    });
    return new Uint8Array(bytes);
  };

  // ZIP (stored, no compression). files: [{ name, data: Uint8Array | string }]
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  X.crc32 = function (d) { let c = 0xffffffff; for (let i = 0; i < d.length; i++) c = CRC[(c ^ d[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  X.zip = function (files) {
    const enc = new TextEncoder();
    const now = new Date();
    const dtime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const ddate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const parts = [], central = [];
    let offset = 0;
    files.forEach(f => {
      const name = enc.encode(f.name);
      const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
      const crc = X.crc32(data);
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
      h.setUint16(10, dtime, true); h.setUint16(12, ddate, true); h.setUint32(14, crc, true);
      h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
      parts.push(new Uint8Array(h.buffer), name, data);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
      c.setUint16(10, 0, true); c.setUint16(12, dtime, true); c.setUint16(14, ddate, true); c.setUint32(16, crc, true);
      c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, name.length, true);
      c.setUint32(42, offset, true);
      central.push(new Uint8Array(c.buffer), name);
      offset += 30 + name.length + data.length;
    });
    const cdSize = central.reduce((a, p) => a + p.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
  };

  /* ===================================================================
     Notes → MIDI tracks
     =================================================================== */
  const BITS = [16, 24, 32];
  const clean = s => String(s).replace(/[^A-Za-z0-9 _-]+/g, '').trim() || 'HEXTRIG';
  const title = s => s.charAt(0) + s.slice(1).toLowerCase();

  // What MIDI notes a trig stands for.
  X.notesFor = function (T, st, snd) {
    if (T.midiCh) return [T.midiNote + (st ? st.note : 0)];
    const m = snd.machine;
    if (m.notes) return m.notes(snd.p);
    return [(m.gm || 60) + (st ? st.note : 0)];
  };

  function midiTracks(log, patterns) {
    return [0, 1, 2, 3, 4, 5].map(i => {
      const T = patterns.tracks[i];
      return {
        name: (i + 1) + ' ' + title(HX.machines.byId[T.machine].name),
        ch: T.midiCh ? T.midiCh - 1 : (HX.machines.byId[T.machine].gm ? 9 : i),
        notes: log.filter(n => n.track === i).flatMap(n => n.notes.map(note => ({ pos: n.pos, len: n.len, note, vel: n.vel }))),
      };
    });
  }

  /* ===================================================================
     BOUNCE (offline)
     =================================================================== */

  // Which notes belong to the bounce, in 16ths from 0. Pure: tested in tests/run.js.
  // A note belongs if its STEP is inside [0, len), wherever micro timing, swing or a
  // retrig moves the sound. With WRAP, sounds outside the loop fold around it, so an
  // early first note lands at the loop's end and a late last one at its start.
  X.events = function (P, startPat, len, tail) {
    const core = HX.core.create(() => P);
    core.reset(0, startPat, 0);
    const out = [];
    core.advanceTo(len + 72).forEach(e => {           // + room for late micro and long retrigs
      if ((e.kind !== 'note' && e.kind !== 'lock') || e.grid < 0 || e.grid >= len - 1e-9) return;
      if (tail === 2) e.pos = ((e.pos % len) + len) % len;
      else if (e.pos < 0) e.pos = 0;
      out.push(e);
    });
    return out.sort((a, b) => a.pos - b.pos);
  };

  X.songLength = P => P.song.entries.reduce((a, e) => a + Math.max(1, P.patterns[e.p].len) * e.r, 0);

  // Fold everything after `len` frames back onto the start (seamless loop), cut, or keep.
  function applyTail(chs, loopFrames, tail, sr) {
    if (tail === 1) {                                           // keep: trim trailing silence
      let end = loopFrames;
      for (let i = chs[0].length - 1; i >= loopFrames; i--) if (chs.some(c => Math.abs(c[i]) > 0.00003)) { end = i + 1; break; }
      return chs.map(c => c.slice(0, end));
    }
    const out = chs.map(c => c.slice(0, loopFrames));
    if (tail === 2) chs.forEach((c, ci) => { for (let i = loopFrames; i < c.length; i++) out[ci][(i - loopFrames) % loopFrames] += c[i]; });
    else { const f = Math.min(loopFrames, Math.round(sr * 0.003)); out.forEach(c => { for (let i = 0; i < f; i++) c[loopFrames - 1 - i] *= i / f; }); }
    return out;
  }

  X.busy = false;
  X.status = '';
  const say = msg => { X.status = msg; S.changed(); };

  X.bounce = async function () {
    if (X.busy) return;
    const cfg = S.project.exportCfg;
    if (!cfg.mix && !cfg.stems && !cfg.midi) { say('Turn on MIX, STEMS or MIDI first.'); return; }
    X.busy = true;
    try {
      const P = JSON.parse(JSON.stringify(S.project));            // freeze: editing during a bounce is safe
      const song = cfg.source === 1 && P.song.entries.length;
      P.song.on = song ? 1 : 0; P.song.loop = 0;
      const startPat = song ? P.song.entries[0].p : P.current;
      const len = song ? X.songLength(P) : cfg.bars * 16;
      const sr = cfg.rate === 1 ? 48000 : 44100;
      const spp = 15 / P.bpm;
      const evs = X.events(P, startPat, len, cfg.tail);
      const loopFrames = Math.round(len * spp * sr);
      const tailSec = cfg.tail === 0 ? 0.05 : Math.min(12, 0.5 + (P.fx.revSize / 127) * 5.5 + (P.fx.dlyFb / 127) * 4 + 0.6);
      const frames = loopFrames + Math.round(tailSec * sr);

      const files = [];
      const pat = P.patterns[startPat];
      const base = 'HEXTRIG ' + (song ? 'Song' : 'A' + (startPat + 1) + ' ' + title(pat.name)) + ' ' + Math.round(P.bpm) + 'bpm';
      const bits = BITS[cfg.bits];

      // the crossfade as it is now (scenes are part of what you hear)
      const view = HX.perform.frozenView();
      const items = evs.map(e => {
        const T = P.patterns[e.patI].tracks[e.track], st = T.steps[e.step];
        return st ? { e, T, st } : null;
      }).filter(Boolean);
      const resolved = items.filter(r => r.e.kind === 'note')
        .map(r => Object.assign(r, { snd: HX.sound.resolve(r.e.track, r.T, r.st, r.e.lfoPos, spp, view) }));

      const render = async (solo, label) => {
        say('Rendering ' + label + '…');
        const oc = new OfflineAudioContext(2, frames, sr);
        const gates = solo == null ? HX.audio._gates.slice() : [0, 1, 2, 3, 4, 5].map(i => (i === solo ? 1 : 0));
        const eng = HX.audio.Engine(oc, { fx: HX.perform.fx(P.fx, view), sweep: HX.perform.sweep(HX.audio._sweep, view), bpm: P.bpm, gates, clean: solo != null });
        const pl = HX.sound.Player(eng);
        items.forEach(r => {
          if (solo != null && r.e.track !== solo) return;
          const t = Math.max(0, r.e.pos * spp + (r.e.ms || 0) / 1000);
          if (r.e.kind === 'lock') pl.lock(r.e.track, t, r.T, r.st, spp, view);
          else pl.note(r.e.track, t, r.T, r.st, r.e.lfoPos, r.e.vel, r.e.gate ? r.e.gate * spp : 0, spp, view);
        });
        const buf = await oc.startRendering();
        return applyTail([buf.getChannelData(0), buf.getChannelData(1)], loopFrames, cfg.tail, sr);
      };

      if (cfg.mix) files.push({ name: base + '/Mix.wav', data: X.wav(await render(null, 'mix'), sr, bits) });
      if (cfg.stems) {
        for (let i = 0; i < 6; i++) {
          const T = pat.tracks[i];
          if (!resolved.some(r => r.e.track === i)) continue;      // silent track: no file
          files.push({ name: base + '/Stems/' + (i + 1) + ' ' + title(HX.machines.byId[T.machine].name) + '.wav', data: X.wav(await render(i, 'stem ' + (i + 1) + ' of 6'), sr, bits) });
        }
      }
      if (cfg.midi) {
        const log = resolved.map(r => ({
          pos: r.e.pos + (r.e.ms || 0) / 1000 / spp, track: r.e.track, vel: r.e.vel,
          len: r.e.gate || HX.SPEEDS[r.T.speed].len, notes: X.notesFor(r.T, r.st, r.snd),
        }));
        files.push({ name: base + '/MIDI.mid', data: X.midi(midiTracks(log, pat), P.bpm, base) });
      }
      const bars = len / 16;
      files.push({ name: base + '/Read me.txt', data: readme({
        what: song ? 'the song list, once through' : 'pattern A' + (startPat + 1) + ' ' + pat.name, bpm: P.bpm, bars,
        sr, bits, tail: ['cut at the last bar', 'kept after the last bar', 'wrapped to the start (seamless loop)'][cfg.tail],
        stems: !!cfg.stems, mutes: HX.audio._gates.some(g => !g),
        perform: describePerform(view),
      }) });

      say('Packing ' + files.length + ' files…');
      const zip = X.zip(files);
      const name = base + ' ' + (Number.isInteger(bars) ? bars : bars.toFixed(2)) + ' bars.zip';
      const res = await X.save(name, zip);
      say(res === 'saved' ? 'Saved ' + name : res === 'declined' ? 'Save cancelled.' : res === 'busy' ? 'Another save is waiting for you. Try again in a moment.' : 'Saving files is not available in this view.');
    } catch (err) {
      console.error(err);
      say('Bounce failed: ' + (err && err.message || err));
    } finally {
      X.busy = false;
      S.changed();
    }
  };

  function readme(o) {
    return [
      'HEXTRIG export',
      '',
      'What:        ' + o.what,
      'Tempo:       ' + o.bpm + ' BPM, 4/4',
      'Length:      ' + o.bars + ' bars',
      'Format:      ' + o.sr + ' Hz, ' + (o.bits === 32 ? '32-bit float' : o.bits + '-bit') + ' WAV',
      'Tail:        ' + o.tail,
      '',
      'Set your DAW to ' + o.bpm + ' BPM and drop every file at bar 1.',
      'MIDI.mid has one track per HEXTRIG track; drums use General MIDI notes on channel 10.',
      o.stems ? 'Stems include each track\'s own delay and reverb, without the master drive, compressor and limiter.' : '',
      o.mutes ? 'Tracks that were muted are muted in Mix.wav; stems include every track that plays.' : '',
      o.perform || '',
      '',
      'Created with HEXTRIG by Iman Anvari',
    ].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n');
  }

  function describePerform(view) {
    const pf = S.project.perform;
    const a = view.sa && HX.perform.count(view.sa), b = view.sb && HX.perform.count(view.sb);
    if ((view.x <= 0 && !a) || (view.x >= 1 && !b) || (!a && !b)) return HX.audio._sweep ? 'The DJ sweep was at ' + HX.audio._sweep + ' and is in the mix.' : '';
    return 'Perform: crossfader at ' + Math.round(view.x * 100) + '% from scene ' + HX.perform.sceneLabel(pf.a) + ' to ' + HX.perform.sceneLabel(pf.b) + '.';
  }

  /* ===================================================================
     Saving
     =================================================================== */
  let dlPromise = null;
  X.canSave = null;            // null = unknown yet, true / false once known
  X.init = function () {
    if (window.claude && window.claude.use) {
      dlPromise = window.claude.use('downloads').then(d => { X.canSave = !!d; S.changed(); return d; }, () => { X.canSave = false; return null; });
    } else X.canSave = true;   // a normal page: plain browser download
  };
  X.save = async function (filename, blob) {
    if (window.claude && window.claude.use) {
      const dl = await (dlPromise || window.claude.use('downloads'));
      if (!dl) return 'unavailable';
      try { await dl.save({ filename, data: blob }); return 'saved'; }
      catch (e) { const c = e && e.code; return c === 'declined' ? 'declined' : c === 'rate_limited' ? 'busy' : 'unavailable'; }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 20000);
    return 'saved';
  };

  /* ===================================================================
     CAPTURE (live, on the bar lines)
     =================================================================== */
  const R = (HX.rec = { state: 'idle', takes: [], startPos: 0, endPos: null, msg: '' });
  let node = null, sink = null, chunks = [], log = [], lastPos = 0, takeNo = 0;
  let playing = null;          // take preview source

  const workletSrc =
    'class R extends AudioWorkletProcessor{process(i){const a=i[0];if(a&&a.length){const l=a[0].slice(0),r=(a[1]||a[0]).slice(0);' +
    'this.port.postMessage({f:currentFrame,l,r},[l.buffer,r.buffer]);}return true}}registerProcessor("hx-rec",R);';

  async function makeRecorder(ac) {
    const onChunk = d => chunks.push(d);
    try {
      if (!ac.__hxWorklet) {
        const url = URL.createObjectURL(new Blob([workletSrc], { type: 'text/javascript' }));
        await ac.audioWorklet.addModule(url);
        ac.__hxWorklet = true;
      }
      const n = new AudioWorkletNode(ac, 'hx-rec', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
      n.port.onmessage = e => onChunk(e.data);
      return n;
    } catch (err) {                                              // fallback: ScriptProcessor
      const n = ac.createScriptProcessor(2048, 2, 2);
      n.onaudioprocess = e => {
        const b = e.inputBuffer;
        onChunk({ f: Math.round(e.playbackTime * ac.sampleRate), l: b.getChannelData(0).slice(0), r: b.getChannelData(Math.min(1, b.numberOfChannels - 1)).slice(0) });
      };
      return n;
    }
  }

  const barsSetting = () => HX.CAPTURE_BARS[S.project.exportCfg.capBars];

  // Arm (or, while armed/recording, cancel / stop at the next bar line).
  R.toggle = async function () {
    if (R.state === 'armed') { R.cancel(); return; }
    if (R.state === 'rec') {
      if (R.endPos == null) { R.endPos = Math.max(R.startPos + 16, Math.ceil((HX.seq.posNow() + 0.01) / 16) * 16); say2('Stopping at bar ' + barOf(R.endPos) + '.'); }
      else R.cancel();
      return;
    }
    const ac = HX.audio.ensure();
    if (HX.audio.ctx().state !== 'running') await ac.resume();
    chunks = []; log = [];
    node = await makeRecorder(ac);
    sink = ac.createGain(); sink.gain.value = 0;
    HX.audio.output().connect(node); node.connect(sink).connect(ac.destination);
    const seq = HX.seq;
    if (!seq.playing) { seq.start({ fromTop: true }); R.startPos = 0; }
    else R.startPos = Math.ceil((seq.posNow() + 0.25) / 16) * 16;
    const bars = barsSetting();
    R.endPos = bars ? R.startPos + bars * 16 : null;
    R.state = 'armed';
    say2(seq.playing && R.startPos > 0 ? 'Armed: starts at bar ' + barOf(R.startPos) + '.' : 'Recording from the top.');
  };
  const barOf = pos => Math.floor(pos / 16) + 1;
  const say2 = msg => { R.msg = msg; S.changed(); };

  R.cancel = function () { teardown(); R.state = 'idle'; say2('Capture cancelled.'); };
  function teardown() {
    try { if (node) { HX.audio.output().disconnect(node); node.disconnect(); if (node.port) node.port.onmessage = null; } } catch (e) {}
    try { if (sink) sink.disconnect(); } catch (e) {}
    node = null; sink = null;
  }

  // Called by the transport on every tick.
  R.tick = function (now) {
    if (R.state === 'idle') return;
    const map = HX.seq.map;
    lastPos = HX.seq.posNow();
    if (R.state === 'armed' && now >= map.timeAt(R.startPos)) { R.state = 'rec'; S.changed(); }
    if (R.state === 'rec' && R.endPos != null && now >= map.timeAt(R.endPos) + 0.08) finish(R.endPos);
  };
  // Transport stopped or paused: keep the full bars recorded so far.
  R.transportStopped = function () {
    if (R.state === 'armed') { R.cancel(); return; }
    if (R.state !== 'rec') return;
    const end = R.endPos != null ? Math.min(R.endPos, lastPos) : lastPos;
    const bars = Math.floor((end - R.startPos) / 16);
    if (bars < 1) { R.cancel(); say2('Stopped before a full bar: nothing kept.'); return; }
    finish(R.startPos + bars * 16);
  };

  // Log notes for the take's MIDI file (pos in 16ths).
  R.note = function (pos, track, T, st, snd, vel, len) {
    if (R.state !== 'rec' && R.state !== 'armed') return;
    if (pos < R.startPos - 0.5 || (R.endPos != null && pos >= R.endPos)) return;
    log.push({ pos, track, vel, len, notes: X.notesFor(T, st, snd), machine: T.machine });
  };

  function finish(endPos) {
    const ac = HX.audio.ctx(), sr = ac.sampleRate, map = HX.seq.map;
    const f0 = Math.round(map.timeAt(R.startPos) * sr), f1 = Math.round(map.timeAt(endPos) * sr);
    const n = f1 - f0;
    const L = new Float32Array(n), Rr = new Float32Array(n);
    chunks.forEach(c => {
      const a = Math.max(f0, c.f), b = Math.min(f1, c.f + c.l.length);
      for (let f = a; f < b; f++) { L[f - f0] = c.l[f - c.f]; Rr[f - f0] = c.r[f - c.f]; }
    });
    teardown();
    chunks = [];
    const P = S.project;
    const take = {
      id: ++takeNo, bars: (endPos - R.startPos) / 16, bpm: P.bpm, sr, L, R: Rr,
      pat: 'A' + (P.current + 1) + ' ' + P.patterns[P.current].name,
      notes: log.filter(x => x.pos < endPos).map(x => Object.assign({}, x, { pos: Math.max(0, x.pos - R.startPos) })),
      tracks: P.patterns[P.current].tracks.map(T => ({ machine: T.machine, midiCh: T.midiCh, midiNote: T.midiNote })),
      at: new Date(),
    };
    R.takes.unshift(take);
    if (R.takes.length > 12) R.takes.pop();
    R.state = 'idle';
    say2('Take ' + take.id + ' ready: ' + take.bars + (take.bars > 1 ? ' bars.' : ' bar.'));
    if (HX.oled) HX.oled.show('TAKE ' + take.id + ' READY', take.bars + (take.bars > 1 ? ' BARS' : ' BAR'), null);
  }

  R.play = function (id) {
    const ac = HX.audio.ensure();
    if (playing) { try { playing.src.stop(); } catch (e) {} const was = playing.id; playing = null; S.changed(); if (was === id) return; }
    const t = R.takes.find(x => x.id === id);
    if (!t) return;
    const b = ac.createBuffer(2, t.L.length, t.sr);
    b.copyToChannel(t.L, 0); b.copyToChannel(t.R, 1);
    const src = ac.createBufferSource(); src.buffer = b; src.loop = true;
    src.connect(ac.destination); src.start();
    playing = { id, src };
    S.changed();
  };
  R.playingId = () => (playing ? playing.id : null);
  R.remove = id => { if (playing && playing.id === id) R.play(id); R.takes = R.takes.filter(x => x.id !== id); S.changed(); };

  R.save = async function (id) {
    const t = R.takes.find(x => x.id === id);
    if (!t) return;
    const bits = BITS[S.project.exportCfg.bits];
    const base = 'HEXTRIG Take ' + t.id + ' ' + clean(t.pat) + ' ' + Math.round(t.bpm) + 'bpm';
    const fakePat = { tracks: t.tracks.map(x => Object.assign({ params: {}, speed: HX.SPEED_1X }, x)) };
    const files = [
      { name: base + '/Capture.wav', data: X.wav([t.L, t.R], t.sr, bits) },
      { name: base + '/Performance.mid', data: X.midi(midiTracks(t.notes, fakePat), t.bpm, base) },
      { name: base + '/Read me.txt', data: readme({ what: 'a live capture of ' + t.pat + ' (everything you played and tweaked)', bpm: t.bpm, bars: t.bars, sr: t.sr, bits, tail: 'exactly ' + t.bars + ' bars; tails from before the first bar are included, so it loops', stems: false, mutes: false }) },
    ];
    say2('Packing take ' + t.id + '…');
    const res = await X.save(base + ' ' + t.bars + ' bars.zip', X.zip(files));
    say2(res === 'saved' ? 'Saved take ' + t.id + '.' : res === 'declined' ? 'Save cancelled.' : res === 'busy' ? 'Another save is waiting for you.' : 'Saving files is not available in this view.');
  };
})(window.HX);
