/* =====================================================================
   HEXTRIG · clock.js
   Musical time ↔ audio time.

   The sequencer counts in "pos" = 16th notes since the transport started.
   A TempoMap is a chain of straight segments pos → seconds. Changing tempo
   adds a segment starting at a position that has not been scheduled yet,
   so everything already scheduled keeps its exact time, and lookups of
   the recent past (live recording, pause) still use the tempo that was
   actually playing then.  Pure: no audio, no DOM.
   ===================================================================== */
window.HX = window.HX || {};
(function (HX) {
  'use strict';
  const KEEP = 4096; // segments of history (enough for long captures with tempo moves)

  function TempoMap(bpm) { this.set(0, 0, bpm || 120); }

  // Start over with a single segment.
  TempoMap.prototype.set = function (pos, time, bpm) {
    this.segs = [{ p0: pos, t0: time, spp: 15 / bpm, bpm }];
    this.bpm = bpm;
    this.spp = 15 / bpm;
  };
  TempoMap.prototype._push = function (pos, time, bpm) {
    const segs = this.segs;
    // a new segment replaces any that start at or after it
    while (segs.length > 1 && segs[segs.length - 1].p0 >= pos) segs.pop();
    if (segs.length === 1 && segs[0].p0 >= pos) segs.pop();
    segs.push({ p0: pos, t0: time, spp: 15 / bpm, bpm });
    if (segs.length > KEEP) segs.shift();
    this.bpm = bpm;
    this.spp = 15 / bpm;
  };
  TempoMap.prototype._segAtPos = function (pos) {
    const s = this.segs;
    for (let k = s.length - 1; k > 0; k--) if (s[k].p0 <= pos) return s[k];
    return s[0];
  };
  TempoMap.prototype._segAtTime = function (time) {
    const s = this.segs;
    for (let k = s.length - 1; k > 0; k--) if (s[k].t0 <= time) return s[k];
    return s[0];
  };
  TempoMap.prototype.timeAt = function (pos) { const g = this._segAtPos(pos); return g.t0 + (pos - g.p0) * g.spp; };
  TempoMap.prototype.posAt = function (time) { const g = this._segAtTime(time); return g.p0 + (time - g.t0) / g.spp; };

  // New tempo from `pos` onward; times before `pos` are unchanged.
  TempoMap.prototype.retempo = function (pos, bpm) {
    if (Math.abs(bpm - this.bpm) < 1e-9) return;
    this._push(pos, this.timeAt(pos), bpm);
  };
  // Same tempo, but `pos` now happens at `time` (stall recovery, continue, sync).
  TempoMap.prototype.shift = function (pos, time, bpm) { this._push(pos, time, bpm || this.bpm); };

  HX.TempoMap = TempoMap;
})(window.HX);
