import { describe, expect, it } from 'vitest';
import { EXIT_MAX_MS, ExitMotion, Fluid, makePart, pointerAway, projectTorus, ride, SandGrid, seeded, Swarm, torusPoints, type Part } from '../webview/break/physics';

const parts = (n: number, rnd = seeded(3), cols = 30): Part[] => Array.from({ length: n }, (_, i) => makePart(i % 7, 60 + (i % cols) * 8, 20 + Math.floor(i / cols) * 18, Math.floor(i / cols), i % cols, rnd));

/** Run `f(t, dt)` for `ms` milliseconds in 16 ms frames. */
function frames(ms: number, f: (t: number, dt: number) => boolean | void): number {
  let t = 0;
  for (; t < ms; t += 16) if (f(t, 16) === false) break;
  return t;
}

describe('break tab motion', () => {
  it('the way in: a part stays home until its start, then settles on a moving target and follows it exactly', () => {
    const p = makePart(0, 100, 50, 0, 0, seeded(1));
    p.d = 500;
    ride(p, 300, 300, 100, 16);
    expect([p.x, p.y]).toEqual([100, 50]);
    let tx = 300;
    frames(4000, (t, dt) => { tx = 300 + t * 0.05; ride(p, tx, 300, t + 500, dt); });
    expect(Math.abs(p.x - tx)).toBeLessThan(0.5);
    expect(Math.abs(p.y - 300)).toBeLessThan(0.5);
  });

  it('the way in: a part that starts on the very first frame leaves from home too, no teleport', () => {
    const p = makePart(0, 100, 50, 0, 0, seeded(1));
    ride(p, 700, 500, 16, 16); // its start time (0) is already past on the first frame
    expect(Math.hypot(p.x - 100, p.y - 50)).toBeLessThan(5);
  });

  it('the way back keeps each part\'s speed, glides without a jump, and lands every real character exactly home by EXIT_MAX_MS', () => {
    const rnd = seeded(2), ps = parts(40, rnd);
    const copy = makePart(1, ps[0].hx, ps[0].hy, 0, 0, rnd, true);
    for (const p of [...ps, copy]) { p.x += 200 + rnd() * 600; p.y -= 150 + rnd() * 400; p.vx = 2400; p.vy = -900; p.a = 0.3; p.s = 1.4; }
    copy.a = 0.8;
    const exit = new ExitMotion([...ps, copy], rnd);
    const firstX = ps[0].x;
    exit.step(16);
    expect(ps[0].x).toBeGreaterThan(firstX); // still moving the way it went
    let worstStep = 0, prev = ps.map((p) => [p.x, p.y]);
    const end = frames(10_000, (t) => {
      const busy = exit.step(t + 16);
      ps.forEach((p, i) => { worstStep = Math.max(worstStep, Math.hypot(p.x - prev[i][0], p.y - prev[i][1])); prev[i] = [p.x, p.y]; });
      return busy;
    });
    expect(end).toBeLessThanOrEqual(EXIT_MAX_MS);
    expect(worstStep).toBeLessThan(45); // a glide: no frame moves a character far, the last one included
    for (const p of ps) expect([p.x, p.y, p.a, p.s]).toEqual([p.hx, p.hy, 1, 1]);
    expect(copy.a).toBe(0);
  });

  it('falling code keeps every grain, through falling, pushing, scooping and pouring', () => {
    const rnd = seeded(4), ps = parts(120, rnd), grid = new SandGrid(400, 300, 8, 18, 4, 2, ps, rnd);
    const pointer = { x: 120, y: 250, seen: true, down: false };
    expect(grid.count()).toBe(120);
    frames(3000, (t) => grid.tick(t, pointer, false));
    expect(grid.busy).toBe(false); // the pile settles
    for (let i = 0; i < 30; i++) { pointer.x = 40 + i * 10; grid.tick(3000 + i * 16, pointer, true); }
    pointer.down = true;
    for (let i = 0; i < 20; i++) grid.tick(4000 + i * 16, pointer, true);
    expect(grid.held.length).toBeGreaterThan(0);
    pointer.down = false;
    frames(4000, (t) => grid.tick(5000 + t, pointer, false));
    expect(grid.held.length).toBe(0);
    expect(grid.count()).toBe(120);
  });

  it('pouring always lands: below the grid, off its side, or over a pile', () => {
    const rnd = seeded(6), ps = parts(120, rnd), grid = new SandGrid(400, 300, 8, 18, 4, 2, ps, rnd);
    const pointer = { x: 120, y: 250, seen: true, down: false };
    frames(3000, (t) => grid.tick(t, pointer, false));
    pointer.down = true;
    for (let i = 0; i < 20; i++) grid.tick(3000 + i * 16, pointer, true);
    expect(grid.held.length).toBeGreaterThan(0);
    pointer.down = false;
    pointer.y = 5000; pointer.x = -300; // the pointer stays out there
    frames(4000, (t) => grid.tick(4000 + t, pointer, false));
    expect(grid.held.length).toBe(0);
    expect(grid.busy).toBe(false);
    expect(grid.count()).toBe(120);
  });

  it('falling code follows a resized tab: no grain is lost, and the pile settles on the new floor', () => {
    const rnd = seeded(7), ps = parts(120, rnd), grid = new SandGrid(400, 300, 8, 18, 4, 2, ps, rnd);
    const pointer = { x: 120, y: 250, seen: false, down: false };
    frames(3000, (t) => grid.tick(t, pointer, false));
    for (const [W, H] of [[800, 600], [200, 150]]) {
      grid.resize(W, H);
      expect(grid.count()).toBe(120);
      frames(4000, (t) => grid.tick(8000 + t, pointer, false));
      expect(grid.count()).toBe(120);
      expect(grid.busy).toBe(false);
      expect(grid.cellOf.filter((g) => g.c >= 0).every((g) => g.c < grid.cols && g.r < grid.rows)).toBe(true);
      expect(grid.cellOf.some((g) => g.r === grid.rows - 1)).toBe(true);
    }
  });

  it('a tab too small for every grain keeps the rest in the hand, and pours them when it grows', () => {
    const rnd = seeded(8), ps = parts(120, rnd), grid = new SandGrid(400, 300, 8, 18, 4, 2, ps, rnd);
    const pointer = { x: 20, y: 20, seen: false, down: false };
    frames(3000, (t) => grid.tick(t, pointer, false));
    grid.resize(30, 40);
    expect(grid.held.length).toBeGreaterThan(0);
    expect(grid.count()).toBe(120);
    grid.resize(400, 300);
    frames(4000, (t) => grid.tick(8000 + t, pointer, false));
    expect(grid.held.length).toBe(0);
    expect(grid.count()).toBe(120);
  });

  it('donut points cover the torus, and the front of the donut faces the light', () => {
    const pts = torusPoints(600);
    expect(pts.length).toBeGreaterThanOrEqual(600);
    const proj = pts.map((q) => projectTorus(q, 1, 0.6, 200, 300, 200));
    expect(proj.every((q) => Number.isFinite(q.x) && Number.isFinite(q.y) && q.ooz > 0)).toBe(true);
    expect(proj.some((q) => q.L > 0) && proj.some((q) => q.L < 0)).toBe(true);
    const xs = proj.map((q) => q.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(100);
  });

  it('the swarm\'s air stays nearly incompressible, and the swarm stays round the pointer', () => {
    const rnd = seeded(5), ps = parts(300, rnd), W = 800, H = 600;
    const swarm = new Swarm(ps, W, H, { w: 4, h: 9 }, rnd);
    let px = 400, py = 300;
    frames(6000, (t) => { px = 400 + 150 * Math.sin(t / 900); py = 300 + 80 * Math.cos(t / 700); swarm.step(0.016, px, py); });
    expect(swarm.fluid.divergence()).toBeLessThan(5);
    const far = ps.filter((p) => Math.hypot(p.x + 4 - px, p.y + 9 - py) > 0.6 * H).length;
    expect(far).toBeLessThan(ps.length * 0.05);
    expect(ps.every((p) => p.x > -20 && p.x < W + 20 && p.y > -20 && p.y < H + 20)).toBe(true);
    swarm.burst(px, py);
    expect(ps.some((p) => Math.hypot(p.vx, p.vy) > 300)).toBe(true);
    // A smaller tab: the walls move with it, and the swarm comes back inside.
    swarm.resize(400, 300);
    frames(4000, () => swarm.step(0.016, 200, 150));
    expect(ps.every((p) => p.x > -20 && p.x < 420 && p.y > -20 && p.y < 320)).toBe(true);
  });

  it('the pointer counts as away with no leave event: stopped at an edge, or still for a while; never while held', () => {
    const q = { seen: true, inside: true, down: false, x: 400, y: 300, idleMs: 100, W: 800, H: 600 };
    expect(pointerAway(q)).toBe(false);
    expect(pointerAway({ ...q, seen: false })).toBe(true);
    expect(pointerAway({ ...q, inside: false })).toBe(true);
    expect(pointerAway({ ...q, y: 595, idleMs: 100 })).toBe(false); // passing by the edge
    expect(pointerAway({ ...q, y: 595, idleMs: 300 })).toBe(true); // stopped there: it went out
    expect(pointerAway({ ...q, x: 5, idleMs: 300 })).toBe(true);
    expect(pointerAway({ ...q, idleMs: 4000 })).toBe(false); // resting in the middle
    expect(pointerAway({ ...q, idleMs: 6000 })).toBe(true);
    expect(pointerAway({ ...q, idleMs: 6000, down: true })).toBe(false);
  });

  it('the fluid projection removes most of the divergence', () => {
    const f = new Fluid(400, 300);
    f.stir(200, 150, 60, (dx, dy, w, k) => { f.u[k] += dx * w; f.v[k] += dy * w; }); // a pure outward flow: all divergence
    const before = f.divergence();
    f.project(40);
    expect(f.divergence()).toBeLessThan(before * 0.5);
  });
});
