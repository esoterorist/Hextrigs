/* =====================================================================
   HEXTRIG · midi.js
   Web MIDI in and out.
     out  clock (24 PPQN), start / stop / continue, per-track notes
     in   clock + transport (when CLOCK is set to MIDI IN), notes → pads

   Times are given in AudioContext seconds and converted to the
   performance.now() timeline that Web MIDI timestamps use, so MIDI lines
   up with what you hear. Everything degrades to a no-op when MIDI is not
   available (unsupported browser, or an embedding that blocks it).
   ===================================================================== */
(function (HX) {
  'use strict';
  const S = HX.state;
  const MIDI = (HX.midi = {
    status: 'off',        // off | asking | ready | unsupported | blocked
    outs: [], ins: [],
    lastIn: '',           // short description of the last message received
  });
  let access = null;
  const active = new Map();   // "ch:note" → off time (audio s), to avoid overlapping notes

  MIDI.init = function () {
    if (access) return Promise.resolve(true);
    if (!navigator.requestMIDIAccess) { MIDI.status = 'unsupported'; S.changed(); return Promise.resolve(false); }
    MIDI.status = 'asking'; S.changed();
    return navigator.requestMIDIAccess({ sysex: false }).then(acc => {
      access = acc;
      MIDI.status = 'ready';
      acc.onstatechange = refresh;
      refresh();
      return true;
    }, () => { MIDI.status = 'blocked'; S.changed(); return false; });
  };

  function refresh() {
    if (!access) return;
    MIDI.outs = [...access.outputs.values()];
    MIDI.ins = [...access.inputs.values()];
    MIDI.ins.forEach(inp => { inp.onmidimessage = onMessage; });
    S.changed();
  }

  const cfg = () => S.project.clock;
  const output = () => MIDI.outs.find(o => o.name === cfg().midiOut) || null;
  MIDI.output = output;

  /* ---------- time conversion ---------- */
  function toPerf(t) {
    const ac = HX.audio.ctx();
    if (!ac) return performance.now();
    const ts = ac.getOutputTimestamp ? ac.getOutputTimestamp() : null;
    if (ts && ts.performanceTime) return ts.performanceTime + (t - ts.contextTime) * 1000;
    return performance.now() + (t - ac.currentTime) * 1000;
  }
  function toAudio(perf) {
    const ac = HX.audio.ctx();
    if (!ac) return 0;
    const ts = ac.getOutputTimestamp ? ac.getOutputTimestamp() : null;
    if (ts && ts.performanceTime) return ts.contextTime + (perf - ts.performanceTime) / 1000;
    return ac.currentTime + (perf - performance.now()) / 1000;
  }

  function send(bytes, t) {
    const o = output();
    if (!o) return;
    try { o.send(bytes, Math.max(performance.now(), toPerf(t))); } catch (e) { /* port closed */ }
  }

  /* ---------- out ---------- */
  MIDI.clock = t => send([0xf8], t);
  MIDI.start = t => send([0xfa], t);
  MIDI.stop = t => send([0xfc], t);
  MIDI.cont = t => send([0xfb], t);

  MIDI.note = function (ch, note, vel, t, dur) {
    if (!output() || !ch) return;
    const c = (ch - 1) & 15, key = c + ':' + note;
    const off = active.get(key);
    if (off != null && off > t) send([0x80 | c, note, 0], t - 0.0005);   // close an overlapping note first
    send([0x90 | c, note, Math.max(1, Math.round(vel * 127))], t);
    send([0x80 | c, note, 0], t + Math.max(0.01, dur));
    active.set(key, t + dur);
  };

  // Drop everything still queued and silence notes that are on.
  MIDI.panic = function () {
    const o = output();
    if (!o) return;
    try { if (o.clear) o.clear(); } catch (e) {}
    const now = HX.audio.now();
    active.forEach((off, key) => {
      if (off > now) { const [c, n] = key.split(':').map(Number); try { o.send([0x80 | c, n, 0]); } catch (e) {} }
    });
    active.clear();
  };

  /* ---------- in ---------- */
  function onMessage(e) {
    const want = cfg().midiIn;
    if (want && e.target && e.target.name !== want) return;
    const d = e.data, st = d[0];
    const t = toAudio(e.timeStamp || performance.now());
    switch (st) {
      case 0xf8: HX.seq.extClock(t); return;
      case 0xfa: HX.seq.extStart(); MIDI.lastIn = 'START'; return;
      case 0xfb: HX.seq.extCont(); MIDI.lastIn = 'CONTINUE'; return;
      case 0xfc: HX.seq.extStop(); MIDI.lastIn = 'STOP'; return;
    }
    const kind = st & 0xf0, ch = (st & 15) + 1;
    if (kind === 0x90 && d[2] > 0) {
      const note = d[1], vel = d[2] / 127;
      MIDI.lastIn = 'NOTE ' + HX.util.noteName(note) + ' CH' + ch;
      const tracks = S.pat().tracks;
      const byCh = tracks.findIndex(T => T.midiCh === ch);
      if (byCh >= 0) HX.seq.pad(byCh, vel, note - tracks[byCh].midiNote);
      else if (note >= 36 && note <= 41) HX.seq.pad(note - 36, vel);         // drum pads C1–F1
      else HX.seq.pad(HX.ui.selTrack, vel, note - 60);                      // play the selected track
      S.changed();
    }
  }
})(window.HX);
