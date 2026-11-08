import { describe, expect, it } from 'vitest';
import { ExitMotion, Fluid, makePart, projectTorus, ride, SandGrid, seeded, Swarm, torusPoints, type Part } from '../webview/break/physics';

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

  it('the way back keeps each part\'s speed, then lands every real character exactly home; copies fade away', () => {
    const rnd = seeded(2), ps = parts(40, rnd);
    const copy = makePart(1, ps[0].hx, ps[0].hy, 0, 0, rnd, true);
    for (const p of [...ps, copy]) { p.x += 200 + rnd() * 100; p.y -= 150; p.vx = 900; p.vy = -400; p.a = 0.3; p.s = 1.4; }
    copy.a = 0.8;
    const exit = new ExitMotion([...ps, copy], rnd);
    const firstX = ps[0].x;
    exit.step(16, 16);
    expect(ps[0].x).toBeGreaterThan(firstX); // still moving the way it went
    const end = frames(10_000, (t, dt) => exit.step(t + 32, dt));
    expect(end).toBeLessThan(4000);
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
  });

  it('the fluid projection removes most of the divergence', () => {
    const f = new Fluid(400, 300);
    f.stir(200, 150, 60, (dx, dy, w, k) => { f.u[k] += dx * w; f.v[k] += dy * w; }); // a pure outward flow: all divergence
    const before = f.divergence();
    f.project(40);
    expect(f.divergence()).toBeLessThan(before * 0.5);
  });
});
