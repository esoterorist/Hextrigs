/* =====================================================================
   HEXTRIG · sound.js
   What a step sounds like, and how events become voices.

   resolve()  base sound → sound lock → p-locks → scene blend → LFO
     · base       the track's sound
     · sound lock a step can play a different saved sound (any machine);
                  it keeps the track's mix (level, pan, delay, reverb)
     · p-locks    per-step values on top
     · scenes     the crossfader blend (perform.js)
     · LFO        per-hit for synth params, a curve for mix params

   Player     turns note and lock events into voices on one Engine and
              remembers the last values per track, for slides:
     · note with SLIDE   starts from the previous step's filter / level /
                         pan / sends (and TONE pitch) and glides to its own
     · lock-only step    moves the ringing note to its locked values,
                         at once or gliding over its SLIDE time
   The live transport and the offline bouncer use the same Player, so a
   bounce sounds like playback. Pure enough to test with a fake engine.
   ===================================================================== */
(function (HX) {
  'use strict';
  const U = HX.util;
  const SND = (HX.sound = {});
  SND.CONT = ['cutoff', 'reso', 'level', 'pan', 'delay', 'reverb'];   // can change while a note rings
  SND.MIX = ['level', 'pan', 'delay', 'reverb'];                       // kept from the track under a sound lock

  SND.base = function (T, st) {
    if (!st || !st.slock) return { machine: T.machine, params: T.params };
    const params = Object.assign({}, T.params, st.slock.params);
    SND.MIX.forEach(id => { params[id] = T.params[id]; });
    return { machine: HX.machines.byId[st.slock.machine] ? st.slock.machine : T.machine, params };
  };

  const stepLen = T => (HX.SPEEDS[T.speed] || HX.SPEEDS[HX.SPEED_1X]).len;
  SND.slideSec = (T, st, spp) => (st && st.slide ? (HX.SLIDES[st.slide] || 0) * spp * stepLen(T) : 0);

  // view: crossfade view (perform.js); undefined = the live one, null = none
  SND.resolve = function (i, T, st, lfoPos, spp, view) {
    if (view === undefined) view = HX.perform && HX.state.project ? HX.perform.view() : null;
    const B = SND.base(T, st);
    const L = st ? st.locks : null;
    const raw = id => (L && L[id] !== undefined ? L[id] : B.params[id]);
    const val = view ? id => HX.perform.blend(view, 't', i, id, raw(id)) : raw;
    const rate = (HX.LFO_RATES[Math.round(val('lfoRate'))] || HX.LFO_RATES[2]).steps;
    const wave = Math.round(val('lfoWave'));
    const dest = HX.LFO_DESTS[Math.round(val('lfoDest'))] || 'cutoff';
    const depth = val('lfoDepth') / 63;
    const phase0 = T.lfoMode === 1 ? 0 : (lfoPos || 0) / rate;
    const lv = depth ? HX.lfo.wave(wave, phase0, i) : 0;
    const v = id => {
      const d = HX.PARAM[id];
      let x = val(id);
      if (depth && dest === id && d.lfo === 'trig') x += lv * depth * (d.max - d.min) / 2;
      return U.clamp(x, d.min, d.max);
    };
    const pre = {};
    SND.CONT.forEach(id => { pre[id] = raw(id); });
    return {
      machine: HX.machines.byId[B.machine],
      p: {
        semi: v('pitch') + (st ? st.note : 0),
        decay: v('decay') / 127, color: v('color') / 127, shape: v('shape') / 127,
        sweep: v('sweep') / 127, contour: v('contour') / 127,
      },
      attack: v('attack'), drive: v('drive'),
      level: val('level'), pan: val('pan'), delay: val('delay'), reverb: val('reverb'),
      cutoff: val('cutoff'), reso: val('reso'),
      pre,                        // mix values before the scene blend (for live crossfading)
      lfo: depth && HX.PARAM[dest].lfo === 'cont'
        ? { dest, depth, phase0, cycleSec: rate * spp * stepLen(T), wave, seed: i } : null,
    };
  };

  const contOf = snd => { const o = {}; SND.CONT.forEach(id => { o[id] = snd[id]; }); return o; };

  /* eng: { voice(i, t, snd, vel, gateSec), lockVoice(i, t, vals, pre, slideSec) } */
  SND.Player = function (eng) {
    const last = [];
    return {
      reset() { last.length = 0; },
      note(i, t, T, st, lfoPos, vel, gateSec, spp, view) {
        const snd = SND.resolve(i, T, st, lfoPos, spp, view);
        const sec = SND.slideSec(T, st, spp);
        if (sec > 0 && last[i]) {
          snd.from = { cont: last[i].cont, sec };
          snd.p.slideFrom = last[i].semi;
          snd.p.slideSec = sec;
        }
        const rec = eng.voice(i, t, snd, vel, gateSec);
        last[i] = { cont: contOf(snd), semi: snd.p.semi };
        return { snd, rec };
      },
      lock(i, t, T, st, spp, view) {
        if (view === undefined) view = HX.perform && HX.state.project ? HX.perform.view() : null;
        const vals = {}, pre = {};
        SND.CONT.forEach(id => {
          if (st.locks[id] === undefined) return;
          pre[id] = st.locks[id];
          vals[id] = view ? HX.perform.blend(view, 't', i, id, st.locks[id]) : st.locks[id];
        });
        if (!Object.keys(vals).length) return null;
        const sec = SND.slideSec(T, st, spp);
        eng.lockVoice(i, t, vals, pre, sec);
        const prev = last[i] || { cont: {}, semi: 0 };
        last[i] = { cont: Object.assign({}, prev.cont, vals), semi: prev.semi };
        return { vals, sec };
      },
    };
  };
})(window.HX);
