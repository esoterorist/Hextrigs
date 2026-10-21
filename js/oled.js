/* =====================================================================
   HEXTRIG · oled.js
   The little screen: pattern + tempo, a live scope of the master output,
   six track activity cells, and a parameter readout whenever a value
   changes. Drawn on a 256 × 64 logical canvas with a pixel font.
   ===================================================================== */
(function (HX) {
  'use strict';
  const S = HX.state;
  const O = (HX.oled = {});
  const W = 256, H = 64;
  let cv, g, scale = 1, overlay = null, scope = null;
  const act = [0, 0, 0, 0, 0, 0];
  let colors = { fg: '#e4edf5', dim: '#3a4650', led: '#ff4a1c', bg: '#050607' };

  O.init = function (canvas) {
    cv = canvas;
    g = cv.getContext('2d');
    const cs = getComputedStyle(document.documentElement);
    const pick = (n, d) => (cs.getPropertyValue(n).trim() || d);
    colors = { fg: pick('--oled-fg', colors.fg), dim: pick('--oled-dim', colors.dim), led: pick('--led', colors.led), bg: pick('--oled-bg', colors.bg) };
    resize();
    window.addEventListener('resize', resize);
  };
  function resize() {
    const r = cv.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.max(W, Math.round(r.width * dpr));
    cv.height = Math.round(cv.width * H / W);
    scale = cv.width / W;
  }

  O.show = function (label, value, norm, bipolar) {
    overlay = { label, value: String(value), norm: norm == null ? null : norm, bipolar, until: performance.now() + 1300 };
  };
  O.flash = (i, vel) => { act[i] = Math.max(act[i], 0.35 + vel * 0.65); };

  const text = (s, x, y, size = 8, color = colors.fg, align = 'left') => {
    g.font = size + 'px Silkscreen, monospace';
    g.fillStyle = color;
    g.textAlign = align;
    g.textBaseline = 'top';
    g.fillText(s, x, y);
  };
  const invChip = (s, x, y, color) => {
    g.font = '8px Silkscreen, monospace';
    const w = Math.ceil(g.measureText(s).width) + 5;
    g.fillStyle = color; g.fillRect(x, y - 1, w, 10);
    text(s, x + 3, y, 8, colors.bg);
    return w;
  };

  O.draw = function () {
    if (!g) return;
    const now = performance.now();
    g.setTransform(scale, 0, 0, scale, 0, 0);
    g.fillStyle = colors.bg;
    g.fillRect(0, 0, W, H);
    const P = S.pat(), seq = HX.seq;

    // top row: pattern · tempo
    const slot = 'A' + (S.project.current + 1);
    text(slot, 3, 3, 8, colors.fg);
    text(P.name, 22, 3, 8, colors.dim);
    const ext = S.project.clock.sync === 1;
    const bpm = ext && seq.ext.bpm ? seq.ext.bpm : S.project.bpm * (1 + seq.nudge * 0.04);
    text(bpm.toFixed(1), 226, 3, 8, seq.nudge ? colors.led : colors.fg, 'right');
    text(ext ? 'EXT' : 'BPM', 253, 3, 8, colors.dim, 'right');
    let cx = 80;
    const blink = Math.floor(now / 250) % 2;
    const q = seq.queued();
    if (q !== null && blink) cx += invChip('>A' + (q + 1), cx, 3, colors.fg) + 3;
    if (seq.rec) cx += invChip(seq.playing ? 'REC' : 'STEP REC', cx, 3, colors.led) + 3;
    if (seq.fill) cx += invChip('FILL', cx, 3, colors.fg) + 3;
    const PF = HX.perform;
    if (PF.edit && cx < 200) cx += invChip('SCN ' + PF.edit.toUpperCase() + (S.project.perform[PF.edit] + 1), cx, 3, colors.fg) + 3;
    else if (PF.all && cx < 200) cx += invChip('ALL', cx, 3, colors.fg) + 3;
    const R = HX.rec;
    if (R && R.state === 'armed' && blink) cx += invChip('CAP', cx, 3, colors.led) + 3;
    if (R && R.state === 'rec') {
      const done = Math.max(0, Math.floor((seq.posNow() - R.startPos) / 16)) + 1;
      cx += invChip('CAP ' + done + (R.endPos != null ? '/' + (R.endPos - R.startPos) / 16 : ''), cx, 3, colors.led) + 3;
    }
    const song = S.project.song;
    if (song.on && song.entries.length && cx < 190) {
      const idx = seq.playing ? seq.info().songIdx : 0;
      cx += invChip('SONG ' + (idx + 1) + '/' + song.entries.length, cx, 3, colors.dim) + 3;
    }

    if (overlay && now < overlay.until) {
      text(overlay.label, 3, 17, 8, colors.dim);
      text(overlay.value, 3, 28, 16, colors.fg);
      if (overlay.norm != null) {
        g.strokeStyle = colors.dim; g.lineWidth = 1;
        g.strokeRect(3.5, 51.5, 249, 6);
        g.fillStyle = colors.fg;
        if (overlay.bipolar) {
          const z = 4 + 248 * 0.5, x = 4 + 248 * overlay.norm;
          g.fillRect(Math.min(z, x), 53, Math.abs(x - z) || 1, 4);
          g.fillRect(z, 50, 1, 9);
        } else g.fillRect(4, 53, 248 * overlay.norm, 4);
      }
    } else {
      drawScope();
      // bottom row: activity cells + position
      for (let i = 0; i < 6; i++) {
        const x = 3 + i * 13;
        g.fillStyle = colors.dim;
        g.fillRect(x, 54, 10, 7);
        if (act[i] > 0.02) { g.globalAlpha = act[i]; g.fillStyle = colors.fg; g.fillRect(x, 54, 10, 7); g.globalAlpha = 1; }
        if (!seq.audible(i)) { g.fillStyle = colors.bg; g.fillRect(x + 2, 57, 6, 1); }
      }
      let status;
      const ac = HX.audio.ctx();
      const blocked = ac && ac.state !== 'running' && (seq.playing || HX.audio.triedSound);
      if (blocked) status = blink ? 'SOUND IS OFF · TAP ANYWHERE' : '';
      else if (seq.waitExt) status = blink ? 'WAITING FOR MIDI START' : '';
      else if (seq.playing && seq.uiCount) status = 'COUNT-IN ' + seq.uiCount;
      else if (seq.playing) {
        const pos = Math.max(0, seq.uiPos || 0);
        status = (Math.floor(pos / 16) + 1) + '.' + (Math.floor(pos / 4) % 4 + 1) + '.' + (pos % 4 + 1) +
          '  STEP ' + String((seq.uiMaster || 0) + 1).padStart(2, '0') + '/' + P.len;
      } else if (seq.paused) status = blink ? 'PAUSED' : '';
      else status = 'STOPPED · ' + P.len + ' STEPS';
      text(status, 253, 54, 8, colors.dim, 'right');
      const late = seq.stats.lastStall > 0 && HX.audio.now() - seq.stats.lastStall < 2;
      if (late) invChip('SYNC', 84, 54, colors.led);
    }
    for (let i = 0; i < 6; i++) act[i] *= 0.86;
  };

  function drawScope() {
    const an = HX.audio.analyser();
    const y0 = 34, amp = 15;
    g.strokeStyle = colors.dim;
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(3, y0 + 0.5); g.lineTo(253, y0 + 0.5); g.stroke();
    if (!an) {
      text('PRESS PLAY', 128, 30, 8, colors.dim, 'center');
      return;
    }
    if (!scope || scope.length !== an.fftSize) scope = new Float32Array(an.fftSize);
    an.getFloatTimeDomainData(scope);
    // align to a rising zero crossing for a steady picture
    let s0 = 0;
    for (let k = 1; k < scope.length / 2; k++) if (scope[k - 1] < 0 && scope[k] >= 0) { s0 = k; break; }
    const n = 250, stride = 2;
    g.strokeStyle = colors.fg;
    g.beginPath();
    for (let x = 0; x < n; x++) {
      const v = scope[Math.min(scope.length - 1, s0 + x * stride)] || 0;
      const y = y0 - Math.max(-1, Math.min(1, v * 1.4)) * amp;
      if (x === 0) g.moveTo(3 + x, y); else g.lineTo(3 + x, y);
    }
    g.stroke();
  }
})(window.HX);
