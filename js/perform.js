/* =====================================================================
   HEXTRIG · perform.js
   Perform mode, after the Octatrack and the Model:Cycles.

   SCENES       8 per project. A scene holds values for any sound
                parameter of any track, plus master FX and the DJ sweep.
                Parameters a scene does not hold stay as they are.
   CROSSFADER   blends scene A → scene B. Continuous values glide,
                choices (LFO wave, rate …) switch halfway.
   EDIT         while a side is in edit, every slider you move writes into
                that scene and the fader sits on that side so you hear it.
   PUNCH        hold A or B to jump there; let go to come back.
   CONTROL ALL  one slider moves the same parameter on all six tracks,
                relative to where each one was. KEEP or REVERT after.

   The blending functions are pure (they take a `view`) and are tested in
   tests/run.js. The live hooks at the bottom push results to the audio.

   scene = { name, t: [ {paramId: value} × 6 ], m: { fxId | 'sweep': value } }
   project.perform = { scenes: [8], a, b, xfade (0..127) }
   ===================================================================== */
(function (HX) {
  'use strict';
  const U = HX.util;
  const PF = (HX.perform = {
    edit: null,      // 'a' | 'b' while editing that side's scene
    punch: null,     // 'a' | 'b' while a punch key is held
    all: null,       // { patI, snap } while CONTROL ALL is on
    sel: 1,          // scene selected in the SCENES panel
  });
  const S = () => HX.state;
  const N = 8;
  PF.N = N;

  // Master values a scene can hold (reverb size is left out: changing it rebuilds the reverb).
  PF.MASTER_IDS = ['sweep', 'dlyTime', 'dlyFb', 'dlyTone', 'revTone', 'revPre', 'mDrive', 'comp', 'volume'];
  const FXP = {};
  HX.FX_PARAMS.forEach(p => { FXP[p.id] = p; });
  FXP.sweep = { id: 'sweep', min: -64, max: 63 };

  PF.blank = name => ({ name: name || 'EMPTY', t: [{}, {}, {}, {}, {}, {}], m: {} });

  /* ---------- templates (absolute values, so they work on any kit) ---------- */
  const ALL = [0, 1, 2, 3, 4, 5];
  const r = () => Math.floor(Math.random() * 128);
  PF.TEMPLATES = [
    { name: 'DUB OUT', make: () => ({ t: ALL.map(i => ({ delay: i < 3 ? 72 : 112, reverb: 72, cutoff: i >= 3 ? 74 : 112 })), m: { dlyFb: 112, dlyTone: 48 } }) },
    { name: 'BREAKDOWN', make: () => ({ t: [{ level: 0 }, { level: 0 }, { decay: 64, reverb: 64 }, { reverb: 72 }, { level: 0 }, { reverb: 104, attack: 40, decay: 112 }], m: {} }) },
    { name: 'RISER', make: () => ({ t: ALL.map(() => ({ reverb: 92, delay: 84 })), m: { sweep: 46, dlyFb: 118 } }) },
    { name: 'CRUSH', make: () => ({ t: ALL.map(() => ({ drive: 112 })), m: { mDrive: 112, comp: 120 } }) },
    { name: 'TAPE STOP', make: () => ({ t: ALL.map(() => ({ pitch: -24, cutoff: 60 })), m: { sweep: -30 } }) },
    { name: 'UNDERWATER', make: () => ({ t: ALL.map(() => ({ cutoff: 44, reso: 72 })), m: { dlyTone: 30, revTone: 20 } }) },
    { name: 'SPACE', make: () => ({ t: ALL.map(() => ({ reverb: 120, delay: 64, decay: 100 })), m: { revPre: 64 } }) },
    { name: 'CHAOS', make: () => ({ t: ALL.map(() => ({ color: r(), shape: r(), sweep: r(), contour: r() })), m: {} }) },
  ];
  PF.fromTemplate = function (k) {
    const T = PF.TEMPLATES[k], made = T.make();
    return { name: T.name, t: ALL.map(i => Object.assign({}, made.t[i] || {})), m: Object.assign({}, made.m) };
  };

  PF.defaults = () => ({
    scenes: [PF.blank('DRY'), ...[0, 1, 2, 3, 4, 5, 6].map(PF.fromTemplate)],
    a: 0, b: 1, xfade: 0,
  });

  // Clean up anything loaded from storage.
  PF.normalize = function (pf) {
    const d = PF.defaults();
    if (!pf || !Array.isArray(pf.scenes)) return d;
    const num = x => (Number.isFinite(+x) ? +x : undefined);
    pf.scenes = ALL.concat([6, 7]).map(k => {
      const sc = pf.scenes[k] || PF.blank();
      const out = PF.blank(String(sc.name || 'EMPTY').slice(0, 12));
      ALL.forEach(i => {
        const src = (sc.t && sc.t[i]) || {};
        Object.keys(src).forEach(id => {
          const p = HX.PARAM[id], v = num(src[id]);
          if (p && v !== undefined) out.t[i][id] = U.clamp(v, p.min, p.max);
        });
      });
      Object.keys(sc.m || {}).forEach(id => {
        const p = FXP[id], v = num(sc.m[id]);
        if (p && PF.MASTER_IDS.includes(id) && v !== undefined) out.m[id] = U.clamp(v, p.min, p.max);
      });
      return out;
    });
    pf.a = Math.abs(+pf.a || 0) % N;
    pf.b = Math.abs(pf.b == null ? 1 : +pf.b || 0) % N;
    pf.xfade = U.clamp(+pf.xfade || 0, 0, 127);          // continuous, not 128 steps
    return pf;
  };

  PF.count = sc => sc.t.reduce((a, o) => a + Object.keys(o).length, 0) + Object.keys(sc.m).length;

  /* ===================== pure blending ===================== */

  // What the crossfade sounds like right now (edit pins the side, then punch, then the fader).
  PF.view = function (perf) {
    perf = perf || S().project.perform;
    let x = perf.xfade / 127;
    const side = PF.edit || PF.punch;
    if (side === 'a') x = 0;
    else if (side === 'b') x = 1;
    return { sa: perf.scenes[perf.a], sb: perf.scenes[perf.b], x };
  };
  PF.frozenView = () => JSON.parse(JSON.stringify(PF.view()));

  // key 't' (track) or 'm' (master). Returns the value to use instead of `base`.
  PF.blend = function (view, key, track, id, base) {
    if (!view) return base;
    const pick = sc => (!sc ? undefined : key === 'm' ? sc.m[id] : (sc.t[track] || {})[id]);
    const a = pick(view.sa), b = pick(view.sb);
    if (a === undefined && b === undefined) return base;
    const va = a === undefined ? base : a, vb = b === undefined ? base : b;
    if (view.x <= 0) return va;
    if (view.x >= 1) return vb;
    const d = key === 'm' ? FXP[id] : HX.PARAM[id];
    if (d && d.type === 'enum') return view.x < 0.5 ? va : vb;
    return va + (vb - va) * view.x;
  };

  PF.fx = function (fx, view) {
    if (view === undefined) view = PF.view();
    const out = Object.assign({}, fx);
    PF.MASTER_IDS.forEach(id => { if (id !== 'sweep') out[id] = PF.blend(view, 'm', 0, id, fx[id]); });
    return out;
  };
  PF.sweep = (v, view) => PF.blend(view === undefined ? PF.view() : view, 'm', 0, 'sweep', v);

  // CONTROL ALL: new values for every track when track i's `id` is set to v (relative to the snapshot).
  PF.allMath = function (snap, i, id, v) {
    const d = HX.PARAM[id];
    return snap.map((p, j) => (j === i || d.type === 'enum' ? v : U.clamp(Math.round(p[id] + (v - snap[i][id])), d.min, d.max)));
  };

  /* ===================== live (UI + audio) ===================== */
  const changed = () => S().changed();

  // Push the current blend to the audio: master FX, sweep, and notes already ringing.
  PF.refresh = function () {
    if (!HX.audio || !HX.audio.ctx()) return;
    HX.audio.applyFx(S().project.fx);
    HX.audio.setSweep(HX.audio._sweep);
    HX.audio.retouch();
  };

  const sceneLabel = k => (k + 1) + ' ' + S().project.perform.scenes[k].name;
  PF.sceneLabel = sceneLabel;

  /* The crossfader is continuous (not 128 steps). Moves are collected and applied
     once per screen frame: the audio params get a short glide (setTargetAtTime in
     audio.js) that bridges one frame to the next, so the sweep has no zipper. Only
     the strip and the screen redraw while you move; the rest of the page, and the
     autosave, wait until you stop. */
  let flushPending = false, settleTimer = null;
  const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : f => setTimeout(f, 16);
  function flushX() {
    flushPending = false;
    const pf = S().project.perform;
    PF.refresh();
    if (HX.ui && HX.ui.renderPerform) HX.ui.renderPerform();
    if (HX.oled) HX.oled.show('XFADE  A ' + sceneLabel(pf.a) + '  ·  B ' + sceneLabel(pf.b), Math.round(pf.xfade / 1.27) + '% B', pf.xfade / 127);
    clearTimeout(settleTimer);
    settleTimer = setTimeout(changed, 300);
  }
  PF.setX = function (v) {
    S().project.perform.xfade = U.clamp(+v, 0, 127);
    if (!flushPending) { flushPending = true; raf(flushX); }
  };
  PF.assign = function (side, d) {
    const pf = S().project.perform;
    pf[side] = (pf[side] + d + N) % N;
    PF.refresh();
    if (HX.oled) HX.oled.show('SCENE ' + side.toUpperCase(), sceneLabel(pf[side]), null);
    changed();
  };
  PF.setAssign = function (side, k) { S().project.perform[side] = k; PF.refresh(); changed(); };
  PF.setPunch = function (side) { PF.punch = side; PF.refresh(); changed(); };

  PF.editScene = () => (PF.edit ? S().project.perform.scenes[S().project.perform[PF.edit]] : null);
  PF.setEdit = function (side) {
    PF.edit = PF.edit === side ? null : side;
    if (PF.edit && PF.all) PF.allKeep();
    PF.refresh();
    if (HX.oled && PF.edit) HX.oled.show('EDIT SCENE ' + PF.edit.toUpperCase(), sceneLabel(S().project.perform[PF.edit]), null);
    changed();
  };
  PF.sceneChanged = function () { PF.refresh(); changed(); };

  PF.allOn = function () {
    S().commit(true);
    PF.edit = null;
    PF.all = { patI: S().project.current, snap: S().pat().tracks.map(T => Object.assign({}, T.params)) };
    changed();
  };
  PF.allSet = function (i, id, v) {
    const P = S().project.patterns[PF.all.patI];
    PF.allMath(PF.all.snap, i, id, v).forEach((x, j) => { P.tracks[j].params[id] = x; P.tracks[j].sdirty = 1; });
  };
  PF.allKeep = function () { PF.all = null; changed(); };
  PF.allRevert = function () {
    if (!PF.all) return;
    S().commit(true);
    const P = S().project.patterns[PF.all.patI];
    PF.all.snap.forEach((p, j) => { P.tracks[j].params = Object.assign({}, p); });
    PF.all = null;
    if (HX.oled) HX.oled.show('CONTROL ALL', 'REVERTED', null);
    changed();
  };
  PF.toggleAll = () => (PF.all ? PF.allKeep() : PF.allOn());

  // SCENES panel actions
  PF.fill = function (k, tpl) { S().commit(true); S().project.perform.scenes[k] = PF.fromTemplate(tpl); PF.sceneChanged(); };
  PF.clear = function (k) { S().commit(true); S().project.perform.scenes[k] = PF.blank(); PF.sceneChanged(); };
  PF.copy = function (from, to) {
    S().commit(true);
    S().project.perform.scenes[to] = JSON.parse(JSON.stringify(S().project.perform.scenes[from]));
    PF.sceneChanged();
  };
})(window.HX);
