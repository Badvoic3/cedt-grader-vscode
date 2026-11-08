/**
 * The break tab (src/ui/breakPanel.ts): the user's code, drawn where the editor draws it, moves into one of five
 * scenes and back. Texts and data come from the host in a JSON block (never run as code); all text goes through
 * textContent. Drawing: one glyph atlas (each character + colour drawn once), the loop stops when nothing moves
 * and while the tab is hidden, slow scenes draw at 30 fps.
 */
import { clamp01, easeInOut, EXIT_MAX_MS, ExitMotion, makePart, type Part, projectTorus, ride, SandGrid, seeded, Swarm, SWARM, torusPoints } from './physics';
import type { BreakData } from '../../src/shared/breakData';

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
const vscode = acquireVsCodeApi();
const D = JSON.parse(document.getElementById('break-data')!.textContent!) as BreakData;
const L = D.texts;

const cv = document.getElementById('c') as HTMLCanvasElement;
const g = cv.getContext('2d', { alpha: false })!;
const card = document.getElementById('card')!;
const foot = document.getElementById('foot')!;
const back = document.getElementById('back') as HTMLButtonElement;
const css = getComputedStyle(document.documentElement);
const BG = css.getPropertyValue('--vscode-editor-background').trim() || '#1f1f1f';
const FG = D.colors.fg || css.getPropertyValue('--vscode-editor-foreground').trim() || '#cccccc';
const dpr = Math.min(devicePixelRatio || 1, 2);
const W = innerWidth, H = innerHeight;
cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); cv.style.width = `${W}px`; cv.style.height = `${H}px`;
g.setTransform(dpr, 0, 0, dpr, 0, 0);
g.font = `${D.font.size}px ${D.font.family}`;
const cw = g.measureText('M').width, lh = D.font.lineHeight;
const rnd = seeded(11);
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---- the code, coloured like the editor: a small lexer + the theme's token colours ----
const KW = new Set('if else for while do return break continue switch case default try catch throw new delete using namespace def elif in not and or import from as class struct public private template typename const static'.split(' '));
const TY = new Set('int long short char bool void double float auto string vector size_t unsigned signed std'.split(' '));
const C = D.colors;
const glyphKeys = new Map<string, number>(), glyphList: { ch: string; c: string }[] = [];
const chars: Part[] = [];
D.lines.slice(0, Math.floor((H - D.layout.y0) / lh)).forEach((line, row) => {
  const re = /(\/\/.*$|#.*$)|("(?:\\.|[^"])*"|'(?:\\.|[^'])*')|(\b\d+(?:\.\d+)?\b)|([A-Za-z_]\w*)|(\s+)|(.)/g;
  let m: RegExpExecArray | null, col = 0;
  while ((m = re.exec(line))) {
    const s = m[0];
    let c = FG;
    if (m[1]) c = (/^#\s*(include|define|if|endif|pragma)/.test(s) ? C.preproc || C.keyword : C.comment) || FG;
    else if (m[2]) c = C.string || FG;
    else if (m[3]) c = C.number || FG;
    else if (m[4]) c = (KW.has(s) ? C.keyword || C.storage : TY.has(s) ? C.storage || C.type : /^\s*\(/.test(line.slice(re.lastIndex)) ? C.func : C.variable) || FG;
    for (const ch of s) {
      if (ch !== ' ' && ch !== '\t') {
        const key = `${ch}\u0000${c}`;
        if (!glyphKeys.has(key)) { glyphKeys.set(key, glyphList.length); glyphList.push({ ch, c }); }
        chars.push(makePart(glyphKeys.get(key)!, D.layout.x0 + col * cw, D.layout.y0 + row * lh, row, col, rnd));
      }
      col += ch === '\t' ? 4 : 1;
    }
  }
});

const gw = Math.ceil(cw * dpr) + 2, gh = Math.ceil(lh * dpr), PER = 64;
const atlas = document.createElement('canvas');
atlas.width = gw * PER; atlas.height = gh * Math.max(1, Math.ceil(glyphList.length / PER));
const ac = atlas.getContext('2d')!;
ac.font = `${D.font.size * dpr}px ${D.font.family}`; ac.textBaseline = 'middle';
glyphList.forEach((q, i) => { ac.fillStyle = q.c; ac.fillText(q.ch, (i % PER) * gw + 1, Math.floor(i / PER) * gh + gh / 2); });
let alpha = 1;
function glyph(p: Part, a = p.a, sc = p.s): void {
  if (a <= 0.01) return;
  if (a !== alpha) g.globalAlpha = alpha = Math.min(1, a);
  const sx = (p.gi % PER) * gw, sy = Math.floor(p.gi / PER) * gh;
  if (sc === 1) g.drawImage(atlas, sx, sy, gw, gh, Math.round(p.x * dpr) / dpr - 1 / dpr, Math.round(p.y * dpr) / dpr, gw / dpr, gh / dpr);
  else g.drawImage(atlas, sx, sy, gw, gh, p.x - ((sc - 1) * cw) / 2, p.y - ((sc - 1) * lh) / 2, (gw / dpr) * sc, (gh / dpr) * sc);
}
/** Copies of the code's own characters, leaving from their source's place (they make a shape dense). */
function copies(total: number): Part[] {
  const out: Part[] = [];
  for (let i = chars.length; i < total && chars.length; i++) { const src = chars[Math.floor(rnd() * chars.length)]; out.push(makePart(src.gi, src.hx, src.hy, src.row, src.col, rnd, true)); }
  return out;
}

const pointer = { x: -1, y: -1, down: false, moved: false, seen: false };

interface Scene {
  parts: Part[];
  /** One frame; false when nothing moves (the loop sleeps until the pointer moves). */
  step(dt: number, t: number): boolean;
  draw(): void;
  press?(): void;
  drag?(dx: number, dy: number): void;
  /** Fade the last frame instead of clearing it (streaks). */
  trails?: number;
  fps: number;
  cardTop: string;
  hint?: string;
  /** Keeps moving with no input. */
  always?: boolean;
  /** Its parts' speed is its own (not measured from the screen). */
  ownSpeed?: boolean;
}

// (a) falling code
function sandScene(): Scene {
  const ox = ((D.layout.x0 % cw) + cw) % cw, oy = ((D.layout.y0 % lh) + lh) % lh;
  const grid = new SandGrid(W, H, cw, lh, ox, oy, chars, rnd);
  let acc = 0;
  return {
    parts: chars, fps: 60, cardTop: '30%', hint: L.sandHint,
    step(dt, t) {
      acc += dt;
      for (let n = 0; acc >= 1000 / 60 && n < 4; n++) { acc -= 1000 / 60; grid.tick(t, pointer, pointer.moved); pointer.moved = false; }
      let moving = grid.busy;
      const k = 1 - Math.pow(0.001, dt / 120);
      chars.forEach((p, i) => {
        const cell = grid.cellOf[i];
        let tx: number, ty: number;
        if (cell.state === 'held') { const a = t * 0.004 + i, r = 4 + Math.sqrt(grid.held.indexOf(i) + 1) * 3.2; tx = pointer.x + Math.cos(a) * r - cw / 2; ty = pointer.y + Math.sin(a) * r * 0.7 - lh / 2; }
        else if (cell.c < 0) return;
        else { tx = ox + cell.c * cw; ty = oy + cell.r * lh; if (cell.state === 'wait') { p.x = tx; p.y = ty; return; } }
        const dx = tx - p.x, dy = ty - p.y;
        if (Math.abs(dx) + Math.abs(dy) > 0.2) { p.x += dx * k; p.y += dy * k; moving = true; } else { p.x = tx; p.y = ty; }
      });
      return moving;
    },
    draw() { for (const p of chars) glyph(p); },
  };
}

// (b, b2) donuts: every part flies from the code onto a point of the turning surface; the 2D donut snaps to the
// character grid and keeps the front-most part in each cell
function donutScene(snap: boolean): Scene {
  const K1 = Math.min(W, H * 1.1) * 0.42, cx = W / 2, cy = H * 0.4, cols = Math.ceil(W / cw) + 1, rows = Math.ceil(H / lh) + 1;
  const want = Math.max(chars.length, Math.min(snap ? 3000 : 2200, Math.round(((K1 * K1) / (cw * lh)) * (snap ? 2.6 : 1.6))));
  const pts = torusPoints(want), parts = chars.concat(copies(pts.length));
  parts.forEach((p, i) => { p.d = (p.row / 30) * 500 + rnd() * (p.copy ? 650 : 250); });
  const where = parts.map((_, i) => pts[i % pts.length]);
  const owner = new Int32Array(cols * rows), meta = parts.map(() => ({ L: 0, ooz: 0, X: 0, Y: 0, e: 0 }));
  let A = 1, B = 0.6, vA = 0.9, vB = 0.45, slowFrames = 0, n = parts.length;
  const shade = (Lt: number) => (Lt > 0 ? Math.min(1, (snap ? 0.7 : 0.72) + Lt * (snap ? 0.21 : 0.2)) : snap ? 0.22 : 0.16);
  return {
    get parts() { return parts.slice(0, n); }, fps: 30, cardTop: '86%', hint: L.donutHint, always: true,
    step(dt, t) {
      const w0 = performance.now();
      if (!pointer.down) { vA += (0.9 - vA) * 0.02; vB += (0.45 - vB) * 0.02; }
      A += (vA * dt) / 1000; B += (vB * dt) / 1000;
      if (snap) owner.fill(-1);
      for (let i = 0; i < n; i++) {
        const p = parts[i], m = meta[i], q = projectTorus(where[i], A, B, K1, cx, cy);
        let tx = q.x - cw / 2, ty = q.y - lh / 2;
        if (snap) { m.X = Math.round(tx / cw); m.Y = Math.round(ty / lh); tx = m.X * cw; ty = m.Y * lh; }
        ride(p, tx, ty, t, dt);
        m.L = q.L; m.ooz = q.ooz; m.e = easeInOut((t - p.d) / 1400);
        if (snap && m.e > 0.98 && m.X >= 0 && m.Y >= 0 && m.X < cols && m.Y < rows) { const k = m.Y * cols + m.X, o = owner[k]; if (o < 0 || meta[o].ooz < q.ooz) owner[k] = i; }
      }
      // a slow machine: fewer copies (never fewer than the real characters)
      if (performance.now() - w0 > 9 && ++slowFrames > 3 && n > chars.length * 2) { n = Math.floor(n * 0.85); slowFrames = 0; }
      for (let i = 0; i < n; i++) {
        const p = parts[i], m = meta[i];
        let s = shade(m.L);
        if (snap && m.e > 0.98 && owner[m.Y * cols + m.X] !== i) s = 0;
        p.a = p.copy ? m.e * s : 1 - m.e * (1 - s);
      }
      return true;
    },
    draw() {
      for (let i = 0; i < n; i++) if (!(meta[i].L > 0)) glyph(parts[i]);
      for (let i = 0; i < n; i++) if (meta[i].L > 0) glyph(parts[i]);
    },
    drag(dx, dy) { vB += dx * 0.02; vA += dy * 0.02; },
  };
}

// (c) breathing: the code gathers into flat, round rings that grow and brighten for 4 s (in), then shrink and dim
// for 6 s (out)
let word = '';
const breath = (t: number) => { const cyc = Math.max(0, t / 1000 - 1.8) % 10, inh = cyc < 4; return { inh, p: inh ? easeInOut(cyc / 4) : 1 - easeInOut((cyc - 4) / 6) }; };
function breatheScene(): Scene {
  const perRing = Math.max(24, Math.floor((2 * Math.PI * Math.min(W, H) * 0.16) / (cw * 1.15)));
  const rings = Math.max(3, Math.ceil(chars.length / perRing)), m = Math.ceil(chars.length / rings);
  chars.forEach((p) => (p.d = rnd() * 400));
  let lit = 1;
  return {
    parts: chars, fps: 30, cardTop: '45%', always: true,
    step(dt, t) {
      const b = breath(t), s = t / 1000, cx = W / 2, cy = H * 0.45, R = Math.min(W, H) * (0.16 + 0.14 * b.p);
      word = t < 1800 ? '' : b.inh ? L.breatheIn : L.breatheOut;
      lit = 0.6 + 0.4 * b.p;
      chars.forEach((p, i) => {
        const ring = i % rings, slot = Math.floor(i / rings), a = (slot / m) * Math.PI * 2 + ring * 0.05 + s * 0.05, r = R + ring * lh * 0.9;
        ride(p, cx + Math.cos(a) * r - cw / 2, cy + Math.sin(a) * r - lh / 2, t, dt);
        p.a = 1 + (lit - 1) * easeInOut((t - p.d) / 1600);
      });
      return true;
    },
    draw() { for (const p of chars) glyph(p); },
  };
}

// (d) swarm: the code swirls after the pointer, carried by a small fluid (physics.ts)
function swarmScene(): Scene {
  const parts = chars.concat(copies(SWARM.count));
  const swarm = new Swarm(parts, W, H, { w: cw / 2, h: lh / 2 }, rnd);
  const look = new Float32Array(parts.length);
  let started = false;
  return {
    parts, fps: 60, cardTop: '18%', trails: 0.55, ownSpeed: true,
    step(dt) {
      if (!pointer.seen) return false;
      started = true;
      swarm.step(dt / 1000, pointer.x, pointer.y);
      parts.forEach((p, i) => {
        if (!swarm.awake(i)) return;
        look[i] = Math.min(1, look[i] + (dt / 1000) * 2.5);
        const near = swarm.depth(i), k = look[i];
        p.s = 1 + (0.7 * 0.6 * near - 0.1) * k;
        p.a = (1 + ((1 - 0.7 * 0.45 * Math.max(0, -near)) * 0.95 - 1) * k) * (p.copy ? Math.min(1, k * 1.6) : 1);
      });
      return true;
    },
    draw() {
      if (!started) { for (const p of chars) glyph(p); return; }
      for (let i = 0; i < parts.length; i++) if (swarm.depth(i) < 0) glyph(parts[i]);
      for (let i = 0; i < parts.length; i++) if (swarm.depth(i) >= 0) glyph(parts[i]);
    },
    press() { swarm.burst(pointer.x, pointer.y); },
  };
}

const S: Scene = { sand: sandScene, donut3d: () => donutScene(false), donut2d: () => donutScene(true), breathe: breatheScene, swarm: swarmScene }[D.scene]();

// ---- the loop: run, then the way back (everything springs home; the last frame is the editor's own layout) ----
let phase: 'run' | 'exit' = 'run', exit: ExitMotion | null = null, tStart = performance.now(), tExit = 0, running = false, last = 0, lastDraw = 0;
function clear(fade = 1): void {
  g.globalAlpha = alpha = fade; g.fillStyle = BG; g.fillRect(0, 0, W, H); g.globalAlpha = alpha = 1;
}
function frame(): void {
  const now = performance.now(), dt = Math.min(50, now - last);
  last = now;
  if (now - lastDraw < 1000 / (phase === 'exit' ? 60 : S.fps) - 2) { requestAnimationFrame(frame); return; }
  lastDraw = now;
  const parts = S.parts;
  let busy: boolean;
  if (phase === 'exit') busy = exit!.step(now - tExit, dt);
  else {
    const before = S.ownSpeed ? null : parts.map((p) => [p.x, p.y]);
    busy = S.step(dt, now - tStart) || !!S.always;
    if (before && dt > 0) parts.forEach((p, i) => { p.vx = ((p.x - before[i][0]) * 1000) / dt; p.vy = ((p.y - before[i][1]) * 1000) / dt; });
  }
  clear(S.trails && pointer.seen && phase === 'run' ? S.trails : 1);
  if (phase === 'exit') for (const p of parts) glyph(p); else S.draw();
  if (phase === 'run') updateCard(now - tStart);
  if (busy) requestAnimationFrame(frame);
  else { running = false; if (phase === 'exit') close(); }
}
function kick(): void {
  if (!running && !reduced && !document.hidden) { running = true; last = performance.now(); requestAnimationFrame(frame); }
}
/** Tell the host the way back is over (once): it closes the tab and gives the keyboard back to the code. */
let closed = false;
function close(): void {
  if (!closed) { closed = true; vscode.postMessage({ type: 'closed' }); }
}
function startExit(): void {
  if (phase === 'exit') return;
  if (reduced) { close(); return; }
  // Frames stop while the window is hidden or behind another one: the tab closes on time anyway.
  setTimeout(close, EXIT_MAX_MS + 500);
  phase = 'exit'; tExit = performance.now();
  card.style.transition = 'opacity 250ms'; card.style.opacity = '0'; back.style.opacity = '0'; foot.textContent = '';
  exit = new ExitMotion(S.parts, rnd);
  kick();
}

// ---- the card: what to do, the time left, how to go back ----
let shown = '';
function el(tag: string, cls: string, text: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls; e.textContent = text;
  return e;
}
function updateCard(t: number): void {
  const left = Math.max(0, D.seconds - Math.floor(t / 1000)), mmss = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  const key = `${D.scene === 'breathe' ? word : ''}${mmss}${pointer.seen ? 1 : 0}`;
  if (key !== shown) {
    shown = key;
    if (D.scene === 'breathe') { card.replaceChildren(el('h1', 'big', word)); foot.textContent = `${L.breakSub} · ${mmss}`; }
    else {
      card.replaceChildren(el('h1', '', left ? L.breakTitle : L.breakDone), el('p', '', L.breakSub), el('div', 'timer', mmss));
      if (D.scene === 'swarm' && !pointer.seen) card.append(el('p', 'small', L.moveMouse));
      if (S.hint) card.append(el('p', 'small', S.hint));
    }
  }
  card.style.top = S.cardTop;
  card.style.opacity = String(clamp01((t - 900) / 500));
}

back.textContent = L.backBtn;
back.setAttribute('aria-label', L.back);
back.dataset.tip = L.back;
back.addEventListener('click', startExit);
addEventListener('keydown', (e) => { if (e.key === 'Escape') startExit(); });
cv.addEventListener('pointermove', (e) => {
  if (pointer.down && S.drag && pointer.seen) S.drag(e.clientX - pointer.x, e.clientY - pointer.y);
  pointer.x = e.clientX; pointer.y = e.clientY; pointer.moved = true; pointer.seen = true; kick();
});
cv.addEventListener('pointerdown', (e) => {
  pointer.down = true; pointer.x = e.clientX; pointer.y = e.clientY; pointer.seen = true;
  if (phase === 'run') S.press?.();
  cv.setPointerCapture(e.pointerId); kick();
});
cv.addEventListener('pointerup', () => { pointer.down = false; kick(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) kick(); });

// the first frame is the code exactly where the editor draws it
clear();
if (reduced) {
  // reduced motion: the code stays still and dimmed, with the card; Esc or Back to code closes at once
  for (const p of chars) glyph(p, 0.25);
  card.replaceChildren(el('h1', '', L.breakTitle), el('p', '', L.breakSub));
  card.style.top = '45%'; card.style.opacity = '1';
} else {
  for (const p of chars) glyph(p);
  tStart = performance.now();
  kick();
  // the countdown has its own tick: the loop sleeps when nothing moves (settled sand), the clock must not
  setInterval(() => { if (phase === 'run') updateCard(performance.now() - tStart); }, 1000);
}
// The keyboard starts on Back to code: Enter or Esc go back at once.
back.focus();
vscode.postMessage({ type: 'ready', chars: chars.length });
