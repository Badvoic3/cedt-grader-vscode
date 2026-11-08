/**
 * The break tab's motion, without the DOM (tested in test/breakPhysics.test.ts). Every scene moves "parts": a
 * character of the user's code, or a copy of one, each with a home (where the editor draws it). The scene moves a
 * part away from home on the way in and the exit spring brings it back, so the change from the editor and back is
 * one continuous motion.
 */

export interface Part {
  /** Glyph (character + colour) index in the atlas. */
  gi: number;
  /** Home: the top-left corner where the editor draws this character. */
  hx: number;
  hy: number;
  row: number;
  col: number;
  x: number;
  y: number;
  /** A copy of a real character (fades in on the way out of the code, fades out on the way back). */
  copy: boolean;
  /** Drawn opacity and scale (the exit eases from these). */
  a: number;
  s: number;
  /** Start time (ms into the scene) of its move out of the code. */
  d: number;
  // way-in spring (offset from the moving target)
  sk: number;
  sd: number;
  on: boolean;
  ex: number;
  ey: number;
  evx: number;
  evy: number;
  // speed on screen, measured each frame (the exit keeps it)
  vx: number;
  vy: number;
}

export type Rnd = () => number;

/** A seeded random number generator (the same scene every time for the same seed). */
export function seeded(seed: number): Rnd {
  let s = seed % 2147483647 || 1;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
export const clamp = (x: number, a: number, b: number): number => (x < a ? a : x > b ? b : x);
export const easeInOut = (x: number): number => {
  x = clamp01(x);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
};

/** Damping ratio about 0.65: a slight overshoot, settled within about 1.3 s. */
export function springPart(p: Part, rnd: Rnd): void {
  p.sk = 30 + rnd() * 20;
  p.sd = 2 * 0.65 * Math.sqrt(p.sk);
  p.on = false;
}

export function makePart(gi: number, hx: number, hy: number, row: number, col: number, rnd: Rnd, copy = false): Part {
  const p: Part = { gi, hx, hy, row, col, x: hx, y: hy, copy, a: copy ? 0 : 1, s: 1, d: 0, sk: 0, sd: 0, on: false, ex: 0, ey: 0, evx: 0, evy: 0, vx: 0, vy: 0 };
  springPart(p, rnd);
  return p;
}

/**
 * The way in: the part rides a spring on the distance still to go to a target that may move (a turning donut);
 * it eases off from home at its start time, overshoots a little, and then follows the target exactly.
 */
export function ride(p: Part, tx: number, ty: number, t: number, dt: number): void {
  if (!p.on) {
    p.ex = p.hx - tx;
    p.ey = p.hy - ty;
    p.evx = p.evy = 0;
    if (t < p.d) {
      p.x = p.hx;
      p.y = p.hy;
      return;
    }
    p.on = true;
  }
  const n = Math.ceil(dt / 8), h = dt / 1000 / n;
  for (let i = 0; i < n; i++) {
    let ax = -p.sk * p.ex - p.sd * p.evx, ay = -p.sk * p.ey - p.sd * p.evy;
    const am = Math.hypot(ax, ay);
    if (am > 5000) { ax *= 5000 / am; ay *= 5000 / am; }
    p.evx += ax * h; p.evy += ay * h; p.ex += p.evx * h; p.ey += p.evy * h;
  }
  p.x = tx + p.ex;
  p.y = ty + p.ey;
}

/** The way back always ends by then: each part's glide has a fixed length, so nothing is cut short. */
export const EXIT_MAX_MS = 1400;

/**
 * The way back: each part glides home on a curve that starts with its current speed and ends at its home with no
 * speed (a cubic Hermite curve), in a fixed time between 700 ms and EXIT_MAX_MS (further parts take longer). Its
 * opacity and size ease back to normal on the way; copies fade out. Deterministic, so the last frame is exactly the
 * editor's layout and no part ever has to jump.
 */
export class ExitMotion {
  private items: { p: Part; T: number; qx: number; qy: number; tx: number; ty: number; fa: number; fs: number }[] = [];

  constructor(parts: readonly Part[], rnd: Rnd) {
    for (const p of parts) {
      const qx = p.x - p.hx, qy = p.y - p.hy, dist = Math.hypot(qx, qy);
      const T = Math.min(EXIT_MAX_MS, 700 + dist * 0.5 + rnd() * 120);
      // The start speed carries on, but never sends a part more than ~110 px the wrong way (0.148·T·v at most).
      const v = Math.hypot(p.vx, p.vy), cap = 110 / (0.148 * (T / 1000)), m = v > cap ? cap / v : 1;
      this.items.push({ p, T, qx, qy, tx: (T / 1000) * p.vx * m, ty: (T / 1000) * p.vy * m, fa: p.a, fs: p.s });
    }
  }

  /** Progress of the slowest part, 0…1. */
  progress(t: number): number {
    let worst = 1;
    for (const it of this.items) worst = Math.min(worst, clamp01(t / it.T));
    return worst;
  }

  /** The frame at `t` ms after the way back started; false once everything is home. */
  step(t: number, _dt = 0): boolean {
    let busy = false;
    for (const it of this.items) {
      const u = clamp01(t / it.T), p = it.p;
      if (u < 1) busy = true;
      const h00 = 2 * u * u * u - 3 * u * u + 1, h10 = u * u * u - 2 * u * u + u, along = easeInOut(u);
      p.x = p.hx + h00 * it.qx + h10 * it.tx;
      p.y = p.hy + h00 * it.qy + h10 * it.ty;
      p.a = p.copy ? it.fa * (1 - along) : it.fa + (1 - it.fa) * along;
      p.s = it.fs + (1 - it.fs) * along;
      if (u >= 1) { p.x = p.hx; p.y = p.hy; p.a = p.copy ? 0 : 1; p.s = 1; }
    }
    return busy;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Falling code: a cell grid like falling-sand games. A grain falls straight down, or slides one cell sideways and
// down; the pointer pushes grains it passes through, holding the button scoops grains up, letting go pours them.

export class SandGrid {
  readonly cols: number;
  readonly rows: number;
  private readonly grid: Int32Array;
  readonly cellOf: { c: number; r: number; state: 'wait' | 'fall' | 'rest' | 'held'; v: number; acc: number; delay: number }[];
  private active = new Set<number>();
  readonly held: number[] = [];

  constructor(W: number, H: number, private readonly cw: number, private readonly lh: number, readonly ox: number, readonly oy: number, parts: readonly Part[], private readonly rnd: Rnd) {
    this.cols = Math.ceil(W / cw) + 1;
    this.rows = Math.max(1, Math.floor((H - oy) / lh));
    this.grid = new Int32Array(this.cols * this.rows).fill(-1);
    this.cellOf = parts.map(() => ({ c: -1, r: -1, state: 'wait' as const, v: 0, acc: 0, delay: 0 }));
    let maxRow = 0;
    parts.forEach((p, i) => {
      const c = Math.round((p.hx - ox) / cw), r = Math.round((p.hy - oy) / lh);
      maxRow = Math.max(maxRow, r);
      if (this.at(c, r) === -1) this.put(i, c, r);
    });
    // the bottom rows go first, each grain a little after the next
    this.cellOf.forEach((g) => (g.delay = (maxRow - g.r) * 45 + rnd() * 700));
  }

  at(c: number, r: number): number {
    return c < 0 || c >= this.cols || r < 0 || r >= this.rows ? -2 : this.grid[r * this.cols + c];
  }

  /** How many grains are in the grid or held: never changes. */
  count(): number {
    let n = this.held.length;
    for (const v of this.grid) if (v >= 0) n++;
    return n;
  }

  get busy(): boolean {
    return this.active.size > 0 || this.held.length > 0 || this.cellOf.some((g) => g.state === 'wait' && g.c >= 0);
  }

  private put(i: number, c: number, r: number): void {
    const g = this.cellOf[i];
    if (g.c >= 0) { this.grid[g.r * this.cols + g.c] = -1; this.wake(g.c, g.r); }
    g.c = c; g.r = r;
    if (c >= 0) this.grid[r * this.cols + c] = i;
  }

  private wake(c: number, r: number): void {
    for (const d of [-1, 0, 1]) {
      const k = this.at(c + d, r - 1);
      if (k >= 0 && this.cellOf[k].state === 'rest') { this.cellOf[k].state = 'fall'; this.active.add(k); }
    }
  }

  private fall(i: number): void {
    const g = this.cellOf[i];
    g.v = Math.min(g.v + 0.16, 3); g.acc += g.v;
    while (g.acc >= 1) {
      g.acc -= 1;
      const c = g.c, r = g.r;
      if (this.at(c, r + 1) === -1) { this.put(i, c, r + 1); continue; }
      const d = this.rnd() < 0.5 ? -1 : 1;
      if (this.at(c + d, r + 1) === -1 && this.at(c + d, r) === -1) { this.put(i, c + d, r + 1); continue; }
      if (this.at(c - d, r + 1) === -1 && this.at(c - d, r) === -1) { this.put(i, c - d, r + 1); continue; }
      g.state = 'rest'; g.v = 0; g.acc = 0; this.active.delete(i);
      return;
    }
  }

  /** One step (60 per second). `pointer` in pixels; `moved`: the pointer moved since the last step. */
  tick(t: number, pointer: { x: number; y: number; seen: boolean; down: boolean }, moved: boolean): void {
    this.cellOf.forEach((g, i) => { if (g.state === 'wait' && t >= g.delay && g.c >= 0) { g.state = 'fall'; this.active.add(i); } });
    const pc = Math.floor((pointer.x - this.ox) / this.cw), pr = Math.floor((pointer.y - this.oy) / this.lh);
    if (pointer.seen && moved && !pointer.down) this.push(pc, pr);
    if (pointer.down) this.scoop(pc, pr);
    else if (this.held.length) this.pour(pc, pr);
    [...this.active].sort((a, b) => this.cellOf[b].r - this.cellOf[a].r).forEach((i) => this.fall(i));
  }

  private push(pc: number, pr: number): void {
    for (let r = pr - 2; r <= pr + 2; r++) for (let c = pc - 3; c <= pc + 3; c++) {
      const k = this.at(c, r);
      if (k < 0) continue;
      const sx = Math.sign(c - pc) || (this.rnd() < 0.5 ? -1 : 1);
      for (const [dc, dr] of [[sx * 2, -1], [sx * 3, -1], [sx, -2], [sx * 2, -2], [sx * 4, 0]]) {
        if (this.at(c + dc, r + dr) === -1) { this.put(k, c + dc, r + dr); const g = this.cellOf[k]; g.state = 'fall'; g.v = 0; this.active.add(k); break; }
      }
    }
  }

  private scoop(pc: number, pr: number): void {
    for (let r = pr - 2; r <= pr + 2; r++) for (let c = pc - 2; c <= pc + 2; c++) {
      const k = this.at(c, r);
      if (k < 0 || this.held.length > 500) continue;
      this.put(k, -1, -1);
      const g = this.cellOf[k]; g.state = 'held'; this.active.delete(k); this.held.push(k);
    }
  }

  private pour(pc: number, pr: number): void {
    pr = Math.max(0, pr);
    for (let n = 0; n < 5 && this.held.length; n++) {
      let placed = false;
      for (const dc of [0, -1, 1, -2, 2]) {
        if (this.at(pc + dc, pr) === -1) { const k = this.held.pop()!; this.put(k, pc + dc, pr); const g = this.cellOf[k]; g.state = 'fall'; g.v = 0.5; this.active.add(k); placed = true; break; }
      }
      if (!placed) return;
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Donuts: points on a torus (tube radius 1, ring radius 2) seen from distance 5, turned by angles A and B.

export interface TorusPoint { ct: number; st: number; cp: number; sp: number }

export function torusPoints(count: number): TorusPoint[] {
  const nt = Math.max(3, Math.round(Math.sqrt(count / 3))), np = Math.ceil(count / nt), out: TorusPoint[] = [];
  for (let i = 0; i < nt; i++) for (let j = 0; j < np; j++) {
    const th = (i / nt) * 2 * Math.PI, ph = (j / np) * 2 * Math.PI + (i % 2) * (Math.PI / np);
    out.push({ ct: Math.cos(th), st: Math.sin(th), cp: Math.cos(ph), sp: Math.sin(ph) });
  }
  return out;
}

/** Screen position (centre), depth (1/z) and light (> 0: facing the light) of a torus point. */
export function projectTorus(q: TorusPoint, A: number, B: number, K1: number, cx: number, cy: number): { x: number; y: number; ooz: number; L: number } {
  const cA = Math.cos(A), sA = Math.sin(A), cB = Math.cos(B), sB = Math.sin(B), ox = 2 + q.ct, oy = q.st;
  const x = ox * (cB * q.cp + sA * sB * q.sp) - oy * cA * sB, y = ox * (sB * q.cp - sA * cB * q.sp) + oy * cA * cB, ooz = 1 / (5 + cA * ox * q.sp + oy * sA);
  const L = q.cp * q.ct * sB - cA * q.ct * q.sp - sA * q.st + cB * (cA * q.st - q.ct * sA * q.sp);
  return { x: cx + K1 * ooz * x, y: cy - K1 * ooz * y * 0.95, ooz, L };
}

// ---------------------------------------------------------------------------------------------------------------
// Swarm: a coarse 2D fluid stirred round the pointer, carrying particles (our own implementation of the textbook
// "stable fluids" steps: self-advection, a swirl-keeping force, and a projection that keeps the flow
// incompressible). The particles are dragged by the flow, held round the pointer, kept apart, and bob in depth.

export class Fluid {
  readonly cols: number;
  readonly rows: number;
  readonly cell: number;
  u: Float32Array;
  v: Float32Array;
  private u0: Float32Array;
  private v0: Float32Array;
  private p: Float32Array;
  private div: Float32Array;
  private w: Float32Array;

  constructor(W: number, H: number, target = 16) {
    this.cols = clamp(Math.round(W / target), 8, 72);
    this.rows = clamp(Math.round(H / target), 8, 48);
    this.cell = Math.max(W / this.cols, H / this.rows);
    const n = this.cols * this.rows;
    [this.u, this.v, this.u0, this.v0, this.p, this.div, this.w] = Array.from({ length: 7 }, () => new Float32Array(n));
  }

  /** The flow's velocity at a point (bilinear). */
  at(f: Float32Array, x: number, y: number): number {
    const gx = clamp(x / this.cell - 0.5, 0, this.cols - 1.001), gy = clamp(y / this.cell - 0.5, 0, this.rows - 1.001);
    const i = gx | 0, j = gy | 0, fx = gx - i, fy = gy - j, k = i + j * this.cols, C = this.cols;
    return (f[k] * (1 - fx) + f[k + 1] * fx) * (1 - fy) + (f[k + C] * (1 - fx) + f[k + C + 1] * fx) * fy;
  }

  /** Add velocity in a round area: `fn(dx, dy, weight)` returns the velocity change for one cell. */
  stir(cx: number, cy: number, radius: number, fn: (dx: number, dy: number, w: number, k: number) => void): void {
    const reach = radius * 2.2, inv = 1 / (radius * radius * 0.55), C = this.cols;
    const i0 = Math.max(1, Math.floor((cx - reach) / this.cell)), i1 = Math.min(C - 2, Math.ceil((cx + reach) / this.cell));
    const j0 = Math.max(1, Math.floor((cy - reach) / this.cell)), j1 = Math.min(this.rows - 2, Math.ceil((cy + reach) / this.cell));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const dx = (i + 0.5) * this.cell - cx, dy = (j + 0.5) * this.cell - cy, wt = Math.exp(-(dx * dx + dy * dy) * inv);
      if (wt >= 0.003) fn(dx, dy, wt, i + j * C);
    }
  }

  /** One fluid step: keep the swirls (vorticity confinement), move the flow along itself, fade, make it incompressible. */
  step(dt: number, swirl: number, fadeTime: number): void {
    const C = this.cols, R = this.rows, h = this.cell, u = this.u, v = this.v, w = this.w;
    for (let j = 1; j < R - 1; j++) for (let i = 1; i < C - 1; i++) { const k = i + j * C; w[k] = (v[k + 1] - v[k - 1] - u[k + C] + u[k - C]) / (2 * h); }
    const eps = swirl * h * 9;
    for (let j = 2; j < R - 2; j++) for (let i = 2; i < C - 2; i++) {
      const k = i + j * C, gx = Math.abs(w[k + 1]) - Math.abs(w[k - 1]), gy = Math.abs(w[k + C]) - Math.abs(w[k - C]), len = Math.hypot(gx, gy) + 1e-5;
      u[k] += (gy / len) * w[k] * eps * dt;
      v[k] -= (gx / len) * w[k] * eps * dt;
    }
    this.u0.set(u); this.v0.set(v);
    const fade = Math.exp(-dt / fadeTime);
    for (let j = 1; j < R - 1; j++) for (let i = 1; i < C - 1; i++) {
      const k = i + j * C;
      const x = clamp(i - (dt / h) * this.u0[k], 0.5, C - 1.5), y = clamp(j - (dt / h) * this.v0[k], 0.5, R - 1.5);
      const i0 = x | 0, j0 = y | 0, fx = x - i0, fy = y - j0, a = i0 + j0 * C;
      u[k] = ((this.u0[a] * (1 - fx) + this.u0[a + 1] * fx) * (1 - fy) + (this.u0[a + C] * (1 - fx) + this.u0[a + C + 1] * fx) * fy) * fade;
      v[k] = ((this.v0[a] * (1 - fx) + this.v0[a + 1] * fx) * (1 - fy) + (this.v0[a + C] * (1 - fx) + this.v0[a + C + 1] * fx) * fy) * fade;
    }
    this.edges(u, -1, 1); this.edges(v, 1, -1);
    this.project(12);
  }

  /** The mean |divergence| of the flow (after `project`, close to zero). */
  divergence(): number {
    const C = this.cols, R = this.rows, h = this.cell;
    let sum = 0, n = 0;
    for (let j = 2; j < R - 2; j++) for (let i = 2; i < C - 2; i++) { const k = i + j * C; sum += Math.abs((this.u[k + 1] - this.u[k - 1] + this.v[k + C] - this.v[k - C]) / (2 * h)); n++; }
    return sum / n;
  }

  /** Make the flow (nearly) divergence-free: solve for pressure with Jacobi sweeps, subtract its gradient. */
  project(sweeps: number): void {
    const C = this.cols, R = this.rows, h = this.cell, u = this.u, v = this.v, p = this.p, div = this.div;
    for (let j = 1; j < R - 1; j++) for (let i = 1; i < C - 1; i++) { const k = i + j * C; div[k] = (u[k + 1] - u[k - 1] + v[k + C] - v[k - C]) / (2 * h); }
    this.edges(div, 1, 1);
    p.fill(0);
    for (let s = 0; s < sweeps; s++) {
      for (let j = 1; j < R - 1; j++) for (let i = 1; i < C - 1; i++) { const k = i + j * C; p[k] = (p[k - 1] + p[k + 1] + p[k - C] + p[k + C] - h * h * div[k]) / 4; }
      this.edges(p, 1, 1);
    }
    for (let j = 1; j < R - 1; j++) for (let i = 1; i < C - 1; i++) { const k = i + j * C; u[k] -= (p[k + 1] - p[k - 1]) / (2 * h); v[k] -= (p[k + C] - p[k - C]) / (2 * h); }
    this.edges(u, -1, 1); this.edges(v, 1, -1);
  }

  /** Edge cells copy their inner neighbour; `sx` / `sy` flip the sign at the left-right / top-bottom walls (no flow through a wall). */
  private edges(f: Float32Array, sx: number, sy: number): void {
    const C = this.cols, R = this.rows;
    for (let j = 1; j < R - 1; j++) { f[j * C] = sx * f[j * C + 1]; f[j * C + C - 1] = sx * f[j * C + C - 2]; }
    for (let i = 1; i < C - 1; i++) { f[i] = sy * f[i + C]; f[i + (R - 1) * C] = sy * f[i + (R - 2) * C]; }
    f[0] = (f[1] + f[C]) / 2; f[C - 1] = (f[C - 2] + f[2 * C - 1]) / 2;
    f[(R - 1) * C] = (f[(R - 2) * C] + f[(R - 1) * C + 1]) / 2; f[R * C - 1] = (f[R * C - 2] + f[(R - 1) * C - 1]) / 2;
  }
}

/** Tuned against the user's recording (measured frame by frame): median speed 0.24 of the height per second, spread 0.13. */
export const SWARM = { count: 650, spread: 0.18, swirl: 0.6, wander: 0.5, hold: 0.7, intro: 1.4 } as const;

/**
 * Is the pointer gone from the tab? A webview nested in VS Code's frames often gets no leave event, so besides one:
 * it stopped right at an edge (it went out that way), or it hasn't moved for a while (the person looked away).
 * While the button is held it always counts as here.
 */
export function pointerAway(q: { seen: boolean; inside: boolean; down: boolean; x: number; y: number; idleMs: number; W: number; H: number }): boolean {
  if (!q.seen) return true;
  if (q.down) return false;
  if (!q.inside) return true;
  const m = SWARM_AWAY.edgePx, atEdge = q.x < m || q.y < m || q.x > q.W - m || q.y > q.H - m;
  return (atEdge && q.idleMs > SWARM_AWAY.edgeIdleMs) || q.idleMs > SWARM_AWAY.idleMs;
}
export const SWARM_AWAY = { edgePx: 28, edgeIdleMs: 250, idleMs: 5000 } as const;

export class Swarm {
  readonly fluid: Fluid;
  private readonly n: number;
  private readonly z: Float32Array;
  private readonly vz: Float32Array;
  private readonly phase: Float32Array;
  private readonly rate: Float32Array;
  private readonly drag: Float32Array;
  private readonly wake: Float32Array;
  private readonly next: Int32Array;
  private heads = new Int32Array(1);
  private time = 0;
  private intro = 0;
  private readonly R: number;
  private last: { x: number; y: number } | null = null;
  private motion = { x: 0, y: 0 };

  constructor(private readonly parts: Part[], private readonly W: number, private readonly H: number, private readonly half: { w: number; h: number }, rnd: Rnd) {
    this.fluid = new Fluid(W, H);
    this.n = parts.length;
    this.R = SWARM.spread * H;
    [this.z, this.vz, this.phase, this.rate, this.drag, this.wake] = Array.from({ length: 6 }, () => new Float32Array(this.n));
    this.next = new Int32Array(this.n);
    parts.forEach((p, i) => {
      this.phase[i] = rnd() * 2 * Math.PI;
      this.rate[i] = 0.5 + rnd() * 1.1;
      this.drag[i] = 10 * (1 - 0.3 * rnd() * rnd()); // some are carried less by the air: a looser tail
      this.wake[i] = ((p.copy ? rnd() * this.n : i) / this.n) * 0.5 + rnd() * 0.3; // the code peels off in reading order
    });
  }

  /** Depth of part i in −1 (far) … 1 (near). */
  depth(i: number): number {
    return clamp(this.z[i] / Math.max(this.R * 0.55, 10), -1, 1);
  }

  /** Whether part i has left the code. */
  awake(i: number): boolean {
    return this.time >= this.wake[i];
  }

  /** A click: kick the particles near it outwards and twist the air. */
  burst(px: number, py: number): void {
    const reach = this.R * 2.2, cx = px, cy = py;
    this.parts.forEach((p, i) => {
      const dx = p.x + this.half.w - cx, dy = p.y + this.half.h - cy, d = Math.hypot(dx, dy) || 1;
      if (d > reach || !this.awake(i)) return;
      const k = (1 - d / reach) * 780;
      p.vx += (dx / d) * k; p.vy += (dy / d) * k;
    });
    const turn = (Math.floor(this.time) % 2 ? -1 : 1) * 520;
    this.fluid.stir(cx, cy, this.R, (dx, dy, w, k) => { const d = Math.hypot(dx, dy) + 1e-3, a = (d / this.R) * w * turn; this.fluid.u[k] += (-dy / d) * a; this.fluid.v[k] += (dx / d) * a; });
  }

  /** One frame (dt in seconds, at most 1/30) toward the pointer at (px, py). */
  step(dt: number, px: number, py: number): void {
    dt = clamp(dt, 0.001, 1 / 30);
    this.time += dt;
    this.intro = Math.min(1, this.intro + dt / SWARM.intro);
    const ease = this.intro * this.intro * (3 - 2 * this.intro);
    if (this.last) {
      const k = 1 - Math.exp(-dt * 30);
      this.motion.x += (clamp((px - this.last.x) / dt, -4000, 4000) - this.motion.x) * k;
      this.motion.y += (clamp((py - this.last.y) / dt, -4000, 4000) - this.motion.y) * k;
    }
    this.last = { x: px, y: py };
    this.stir(px, py, dt, ease);
    this.fluid.step(dt, SWARM.swirl, 0.35 + 1.5 * SWARM.swirl);
    this.move(dt / 2, px, py, ease);
    this.move(dt / 2, px, py, ease);
  }

  private stir(px: number, py: number, dt: number, ease: number): void {
    const R = this.R, f = this.fluid, moving = Math.hypot(this.motion.x, this.motion.y);
    const follow = (1 - Math.exp(-dt * 20)) * clamp01(moving / 240);
    const spin = R * (0.5 + 4 * (1 - ease)); // a strong swirl while the code arrives, a gentle one after
    const churn = SWARM.wander * R * 14, kf = 1.4 / R, ft = this.time * 0.75;
    f.stir(px, py, R, (dx, dy, w, k) => {
      const d = Math.hypot(dx, dy) + 1e-3, x = dx + px, y = dy + py, out = Math.min(1, d / (R * 0.45));
      f.u[k] += (this.motion.x - f.u[k]) * w * follow + (-dy / d) * spin * out * w * dt;
      f.v[k] += (this.motion.y - f.v[k]) * w * follow + (dx / d) * spin * out * w * dt;
      // a slowly drifting, divergence-free noise (the curl of two crossed waves): the turbulence
      const a = x * kf + ft, b = y * kf * 1.1 - ft * 0.8, c = y * kf * 1.7 + ft * 1.2 + 1.3, e = x * kf * 1.3 - 0.7;
      f.u[k] += (-Math.sin(a) * Math.sin(b) * 1.1 + 1.02 * Math.cos(c) * Math.cos(e)) * churn * w * dt;
      f.v[k] += -(Math.cos(a) * Math.cos(b) - 0.78 * Math.sin(c) * Math.sin(e)) * churn * w * dt;
    });
  }

  private move(dt: number, px: number, py: number, ease: number): void {
    const R = this.R, f = this.fluid, hw = this.half.w, hh = this.half.h;
    const gather = 12 * SWARM.hold * (0.2 + 0.8 * ease), pull = 30 * SWARM.hold * (0.2 + 0.8 * ease);
    const gap = R * Math.sqrt(Math.PI / this.n) * 1.6, cols = Math.ceil(this.W / gap) + 2, rows = Math.ceil(this.H / gap) + 2;
    if (this.heads.length < cols * rows) this.heads = new Int32Array(cols * rows);
    this.heads.fill(-1, 0, cols * rows);
    const cellOf = (x: number, y: number) => clamp(Math.floor(y / gap) + 1, 0, rows - 1) * cols + clamp(Math.floor(x / gap) + 1, 0, cols - 1);
    this.parts.forEach((p, i) => { if (!this.awake(i)) return; const k = cellOf(p.x + hw, p.y + hh); this.next[i] = this.heads[k]; this.heads[k] = i; });
    this.parts.forEach((p, i) => {
      if (!this.awake(i)) return;
      const x = p.x + hw, y = p.y + hh;
      let ax = (f.at(f.u, x, y) - p.vx) * this.drag[i], ay = (f.at(f.v, x, y) - p.vy) * this.drag[i];
      const cx = clamp(Math.floor(x / gap) + 1, 0, cols - 1), cy = clamp(Math.floor(y / gap) + 1, 0, rows - 1);
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
        const r = cy + oy, c = cx + ox;
        if (r < 0 || r >= rows || c < 0 || c >= cols) continue;
        for (let j = this.heads[r * cols + c]; j !== -1; j = this.next[j]) {
          if (j === i) continue;
          const q = this.parts[j], dx = x - q.x - hw, dy = y - q.y - hh, d2 = dx * dx + dy * dy;
          if (d2 >= gap * gap || d2 < 1e-6) continue;
          const d = Math.sqrt(d2), s = 1 - d / gap;
          ax += (dx / d) * s * s * 4000; ay += (dy / d) * s * s * 4000;
        }
      }
      const dx = px - x, dy = py - y, d = Math.hypot(dx, dy) + 1e-3, over = Math.max(0, d - R);
      ax += (dx / d) * (d * gather + over * pull); ay += (dy / d) * (d * gather + over * pull);
      if (this.intro >= 1) {
        if (x < 8) ax += (8 - x) * 30; else if (x > this.W - 8) ax -= (x - this.W + 8) * 30;
        if (y < 8) ay += (8 - y) * 30; else if (y > this.H - 8) ay -= (y - this.H + 8) * 30;
      }
      const lift = Math.sin(this.time * this.rate[i] + this.phase[i]) * R * 0.55;
      this.vz[i] += ((lift - this.z[i]) * 36 - this.vz[i] * 9) * dt;
      this.z[i] += this.vz[i] * dt;
      p.vx += ax * dt; p.vy += ay * dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
    });
  }
}
