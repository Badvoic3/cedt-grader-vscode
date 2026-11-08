/**
 * The break tab (src/ui/breakPanel.ts): the user's code, drawn where the editor draws it, moves into one of five
 * scenes and back. Texts and data come from the host in a JSON block (never run as code); all text goes through
 * textContent. Drawing: one glyph atlas (each character + colour drawn once), the loop stops when nothing moves
 * and while the tab is hidden, slow scenes draw at 30 fps.
 */
import { clamp01, easeInOut, EXIT_MAX_MS, ExitMotion, makePart, type Part, pointerAway, projectTorus, ride, SandGrid, seeded, Swarm, SWARM, torusPoints } from './physics';
import { reducedMotion } from '../look';
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
/** A theme colour as VS Code gives it to webviews (with the user's colour customizations). */
const themeColor = (name: string) => css.getPropertyValue(`--vscode-${name.replace(/\./g, '-')}`).trim();
const transparent = (c: string) => !c || c === 'transparent' || /^#(?:[0-9a-f]{3}0|[0-9a-f]{6}00)$/i.test(c) || /rgba\([^)]*,\s*0(?:\.0+)?\)$/.test(c);
const BG = themeColor('editor.background') || '#1f1f1f';
const FG = themeColor('editor.foreground') || D.colors.fg || '#cccccc';
const dpr = Math.min(devicePixelRatio || 1, 2);
// The tab loads hidden, at a placeholder size: the first frame is drawn on a screen-sized canvas, and the real
// size is taken when the tab comes forward ("go").
let W = Math.max(innerWidth, screen.availWidth || 0), H = Math.max(innerHeight, screen.availHeight || 0), alpha = 1;
function size(): void {
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); cv.style.width = `${W}px`; cv.style.height = `${H}px`;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  alpha = 1;
}
size();
const V = D.view;
const fontOf = (bits: number, size = D.font.size) => `${bits & 1 ? 'italic ' : ''}${bits & 2 ? 'bold' : V.fontWeight} ${size}px ${D.font.family}`;
g.font = fontOf(0);
const LS = V.letterSpacing;
const cw = g.measureText('M').width + LS, lh = D.font.lineHeight;
const rnd = seeded(11);
const reduced = reducedMotion();

// ---- where the editor draws: VS Code's layout rules (glyph margin, line numbers, decorations lane), measured
// with the same font, and the scroll snapped to a whole line by the host ----
const maxDigit = Math.max(...'0123456789'.split('').map((d) => g.measureText(d).width));
const halfWidth = g.measureText('x').width;
const glyphMarginW = V.glyphMargin ? lh : 0;
const numbersW = V.lineNumbers === 'off' ? 0 : Math.round(Math.max(String(V.lineCount).length, V.lineNumbersMinChars) * maxDigit);
const decorationsW = (typeof V.lineDecorationsWidth === 'string' && /ch$/.test(V.lineDecorationsWidth) ? parseFloat(V.lineDecorationsWidth) * halfWidth : Number(V.lineDecorationsWidth) || 0) + (V.folding ? 16 : 0);
const X0 = glyphMarginW + numbersW + decorationsW, Y0 = V.top;
const rowsShown = D.lines.length;

// ---- the code, coloured like the editor: its grammar's colours from the host, or a small lexer ----
const brackets = [1, 2, 3, 4, 5, 6].map((n) => themeColor(`editorBracketHighlight.foreground${n}`)).filter((c) => !transparent(c));
const resolve = (entry: string): string => {
  if (entry === 'fg') return FG;
  if (entry === 'bu') return themeColor('editorBracketHighlight.unexpectedBracket.foreground') || FG;
  const b = /^b(\d+)$/.exec(entry);
  if (b) return brackets.length ? brackets[Number(b[1]) % brackets.length] : FG;
  return entry;
};
const KW = new Set('if else for while do return break continue switch case default try catch throw new delete using namespace def elif in not and or import from as class struct public private template typename const static'.split(' '));
const TY = new Set('int long short char bool void double float auto string vector size_t unsigned signed std'.split(' '));
const C = D.colors;
/** One colour (and font style) per character: the host's paint, or the lexer. */
function lineColors(line: string, row: number): { c: string[]; f: number[] } {
  const c = new Array<string>(line.length).fill(FG), f = new Array<number>(line.length).fill(0);
  const runs = D.paint?.runs[row];
  if (D.paint && runs) {
    const pal = D.paint.palette.map(resolve);
    for (let k = 0, x = 0; k < runs.length; k += 3) for (let n = 0; n < runs[k]; n++, x++) { c[x] = pal[runs[k + 1]]; f[x] = runs[k + 2]; }
    return { c, f };
  }
  const re = /(\/\/.*$|#.*$)|("(?:\\.|[^"])*"|'(?:\\.|[^'])*')|(\b\d+(?:\.\d+)?\b)|([A-Za-z_]\w*)|(\s+)|(.)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    const t = m[0];
    let col = FG;
    if (m[1]) col = (/^#\s*(include|define|if|endif|pragma)/.test(t) ? C.preproc || C.keyword : C.comment) || FG;
    else if (m[2]) col = C.string || FG;
    else if (m[3]) col = C.number || FG;
    else if (m[4]) col = (KW.has(t) ? C.keyword || C.storage : TY.has(t) ? C.storage || C.type : /^\s*\(/.test(line.slice(re.lastIndex)) ? C.func : C.variable) || FG;
    c.fill(col, m.index, m.index + t.length);
  }
  return { c, f };
}

const glyphKeys = new Map<string, number>(), glyphList: { ch: string; c: string; f: number }[] = [];
const chars: Part[] = [];
const ascii = /^[\x20-\x7e\t]*$/;
D.lines.slice(0, rowsShown).forEach((line, row) => {
  const { c, f } = lineColors(line, row);
  // Tabs go to the next tab stop; other text is placed by the font's own advances (the DOM does the same).
  let col = 0, prefix = '';
  const fast = ascii.test(line);
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const at = fast ? col * cw : g.measureText(prefix).width + prefix.length * LS;
    if (ch !== ' ' && ch !== '\t') {
      const key = `${ch}\u0000${c[i]}\u0000${f[i]}`;
      if (!glyphKeys.has(key)) { glyphKeys.set(key, glyphList.length); glyphList.push({ ch, c: c[i], f: f[i] }); }
      chars.push(makePart(glyphKeys.get(key)!, X0 + at, Y0 + row * lh, row, col, rnd));
    }
    const step = ch === '\t' ? V.tabSize - (col % V.tabSize) : 1;
    col += step;
    prefix += ch === '\t' ? ' '.repeat(step) : ch;
  }
});

// The atlas: each character + colour + style drawn once, on the editor's baseline (CSS centres the font's
// ascent + descent in the line box).
const gw = Math.ceil(cw * dpr) + 2, gh = Math.ceil(lh * dpr), PER = 64;
const atlas = document.createElement('canvas');
atlas.width = gw * PER; atlas.height = gh * Math.max(1, Math.ceil(glyphList.length / PER));
const ac = atlas.getContext('2d')!;
// The baseline exactly where the editor's DOM puts it: an invisible line with the editor's font and line height,
// measured (the canvas only reports rounded font metrics), then floored to a device pixel as text is drawn.
const baseCss = (() => {
  const line = document.createElement('div'), mark = document.createElement('span');
  line.style.cssText = `position:absolute;left:0;top:0;visibility:hidden;white-space:pre;font:${fontOf(0)};line-height:${lh}px;height:${lh}px`;
  mark.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
  line.append(document.createTextNode('M'), mark);
  document.body.append(line);
  const y = mark.getBoundingClientRect().top - line.getBoundingClientRect().top;
  line.remove();
  return y > 0 && y < lh ? y : lh * 0.75;
})();
const baseline = Math.floor(baseCss * dpr), ascent = (g.measureText('M').fontBoundingBoxAscent ?? D.font.size * 0.8) * dpr;
ac.textBaseline = 'alphabetic';
glyphList.forEach((q, i) => {
  const gx = (i % PER) * gw + 1, gy = Math.floor(i / PER) * gh;
  ac.font = fontOf(q.f, D.font.size * dpr);
  ac.fillStyle = q.c;
  ac.fillText(q.ch, gx, gy + baseline);
  if (q.f & 12) {
    const w = ac.measureText(q.ch).width;
    if (q.f & 4) ac.fillRect(gx, gy + baseline + Math.max(1, dpr), w, Math.max(1, dpr));
    if (q.f & 8) ac.fillRect(gx, gy + baseline - ascent * 0.3, w, Math.max(1, dpr));
  }
});
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

// ---- what the editor shows around the code (line numbers, indent guides, current line), drawn on the first and
// last frames and faded in between, so the tab opens and closes on a picture of the editor ----
const indentOf = (line: string) => { let n = 0; for (const ch of line) { if (ch === ' ') n++; else if (ch === '\t') n += V.tabSize - (n % V.tabSize); else return n; } return -1; };
const indents = D.lines.slice(0, rowsShown).map(indentOf);
/** VS Code's rule for blank lines: they take their guides from the content lines around them. */
const guideLevels = indents.map((ind, i) => {
  if (ind >= 0) return Math.ceil(ind / V.tabSize);
  let up = -1, down = -1;
  for (let k = i - 1; k >= 0 && up < 0; k--) up = indents[k];
  for (let k = i + 1; k < indents.length && down < 0; k++) down = indents[k];
  if (up < 0 || down < 0) return 0;
  if (up < down) return 1 + Math.floor(up / V.tabSize);
  if (up === down) return Math.ceil(down / V.tabSize);
  return 1 + Math.floor(down / V.tabSize);
});
const cursorRow = V.cursor ? V.cursor.line - V.firstLine : -1;
// The active guide: the block the cursor line sits in.
const activeLevel = cursorRow >= 0 && cursorRow < rowsShown ? guideLevels[cursorRow] - 1 : -1;
let activeFrom = cursorRow, activeTo = cursorRow;
if (activeLevel >= 0) {
  while (activeFrom > 0 && guideLevels[activeFrom - 1] > activeLevel) activeFrom--;
  while (activeTo < rowsShown - 1 && guideLevels[activeTo + 1] > activeLevel) activeTo++;
  // Blank lines at the block's ends don't carry the active guide.
  while (activeTo > cursorRow && indents[activeTo] < 0) activeTo--;
  while (activeFrom < cursorRow && indents[activeFrom] < 0) activeFrom++;
}
const spaceW = cw;
const chrome = {
  numberFg: themeColor('editorLineNumber.foreground') || '#6e7681',
  numberActive: themeColor('editorLineNumber.activeForeground') || FG,
  guide: themeColor('editorIndentGuide.background1') || themeColor('editorIndentGuide.background') || '#404040',
  guideActive: themeColor('editorIndentGuide.activeBackground1') || themeColor('editorIndentGuide.activeBackground') || '#707070',
  lineBg: themeColor('editor.lineHighlightBackground'),
  lineBorder: themeColor('editor.lineHighlightBorder'),
  cursor: themeColor('editorCursor.foreground') || FG,
};
/** Where the cursor sits on its line (tabs expanded, as the characters are placed). */
const cursorX = (() => {
  if (!V.cursor || cursorRow < 0 || cursorRow >= rowsShown) return -1;
  const line = D.lines[cursorRow].slice(0, V.cursor.character);
  let col = 0;
  for (const ch of line) col += ch === '\t' ? V.tabSize - (col % V.tabSize) : 1;
  return ascii.test(line) ? X0 + col * cw : X0 + g.measureText(line.replace(/\t/g, ' '.repeat(V.tabSize))).width;
})();
function drawChrome(a: number): void {
  if (a <= 0.01) return;
  g.globalAlpha = alpha = a;
  if (cursorRow >= 0 && cursorRow < rowsShown && /line|all/.test(V.renderLineHighlight)) {
    const y = Y0 + cursorRow * lh, x = V.renderLineHighlight === 'all' ? 0 : X0;
    if (!transparent(chrome.lineBg)) { g.fillStyle = chrome.lineBg; g.fillRect(x, y, W - x, lh); }
    else if (!transparent(chrome.lineBorder)) { g.strokeStyle = chrome.lineBorder; g.lineWidth = 2; g.strokeRect(x + 1, y + 1, W - x - 2, lh - 2); }
  }
  if (V.indentGuides) {
    for (let r = 0; r < rowsShown; r++) {
      for (let k = 0; k < guideLevels[r]; k++) {
        const x = Math.round((X0 + k * V.tabSize * spaceW) * dpr) / dpr;
        g.fillStyle = k === activeLevel && r >= activeFrom && r <= activeTo ? chrome.guideActive : chrome.guide;
        g.fillRect(x, Y0 + r * lh, 1, lh);
      }
    }
  }
  if (V.focused && cursorX >= 0) { g.fillStyle = chrome.cursor; g.fillRect(Math.round(cursorX * dpr) / dpr, Y0 + cursorRow * lh, 2, lh); }
  if (V.lineNumbers !== 'off') {
    g.font = fontOf(0); g.textAlign = 'right'; g.textBaseline = 'alphabetic';
    for (let r = 0; r < rowsShown; r++) {
      const n = V.firstLine + r + 1, current = r === cursorRow;
      let label = String(n);
      if (V.lineNumbers === 'relative' && !current && V.cursor) label = String(Math.abs(n - 1 - V.cursor.line));
      if (V.lineNumbers === 'interval' && !current && n % 10 !== 0 && n !== 1) continue;
      g.fillStyle = current ? chrome.numberActive : chrome.numberFg;
      g.fillText(label, glyphMarginW + numbersW, Y0 + r * lh + baseline / dpr);
    }
    g.textAlign = 'left';
  }
}

const pointer = { x: -1, y: -1, down: false, moved: false, seen: false, inside: false, at: 0 };

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
  const ox = ((X0 % cw) + cw) % cw, oy = ((Y0 % lh) + lh) % lh;
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
  // Where the swarm heads: the pointer while it is over the tab; otherwise a hand-like wander (two slow, drifting
  // loops) that starts from where the pointer was and eases there with a spring, so nothing jumps either way.
  const lead = { x: W / 2, y: H * 0.45, vx: 0, vy: 0 };
  const wander = (t: number) => ({
    x: W / 2 + W * 0.3 * Math.sin(t * 0.00029 + 1.3 * Math.sin(t * 0.00011)),
    y: H * 0.47 + H * 0.26 * Math.sin(t * 0.00041 + 1.7 + 1.1 * Math.cos(t * 0.00013)),
  });
  return {
    parts, fps: 60, cardTop: '18%', trails: 0.55, ownSpeed: true, always: true,
    step(dt, t) {
      if (!pointerAway({ ...pointer, idleMs: performance.now() - pointer.at, W, H })) { lead.x = pointer.x; lead.y = pointer.y; lead.vx = 0; lead.vy = 0; }
      else {
        const w = wander(t), s = dt / 1000, k = 6, c = 2 * Math.sqrt(k) * 0.9;
        lead.vx += ((w.x - lead.x) * k - lead.vx * c) * s; lead.vy += ((w.y - lead.y) * k - lead.vy * c) * s;
        lead.x += lead.vx * s; lead.y += lead.vy * s;
      }
      swarm.step(dt / 1000, lead.x, lead.y);
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
      for (let i = 0; i < parts.length; i++) if (swarm.depth(i) < 0) glyph(parts[i]);
      for (let i = 0; i < parts.length; i++) if (swarm.depth(i) >= 0) glyph(parts[i]);
    },
    press() { swarm.burst(pointer.x, pointer.y); },
  };
}

/** The scene, made when the tab comes forward (it needs the tab's real size). */
let S!: Scene;
const makeScene = () => ({ sand: sandScene, donut3d: () => donutScene(false), donut2d: () => donutScene(true), breathe: breatheScene, swarm: swarmScene })[D.scene]();

// ---- the loop: run, then the way back (everything springs home; the last frame is the editor's own layout) ----
const CHROME_OUT_MS = 450;
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
    busy = S.step(dt, now - tStart) || !!S.always || now - tStart < CHROME_OUT_MS + 50;
    if (before && dt > 0) parts.forEach((p, i) => { p.vx = ((p.x - before[i][0]) * 1000) / dt; p.vy = ((p.y - before[i][1]) * 1000) / dt; });
  }
  clear(S.trails && phase === 'run' ? S.trails : 1);
  // The editor's gutter and guides: gone as the code leaves, back as it lands (whole on the last frame).
  drawChrome(phase === 'exit' ? (busy ? easeInOut((now - tExit - 0.35 * EXIT_MAX_MS) / (0.55 * EXIT_MAX_MS)) : 1) : 1 - easeInOut((now - tStart) / CHROME_OUT_MS));
  if (phase === 'exit') for (const p of parts) glyph(p); else S.draw();
  if (phase === 'run') updateCard(now - tStart);
  if (busy) requestAnimationFrame(frame);
  else { running = false; if (phase === 'exit') landed(); }
}
function kick(): void {
  if (!running && !reduced && !document.hidden) { running = true; last = performance.now(); requestAnimationFrame(frame); }
}
/** Tell the host the way back is over (once): it closes the tab and gives the keyboard back to the code. */
let closed = false;
function close(): void {
  if (!closed) { closed = true; vscode.postMessage({ type: 'closed' }); }
}
/** The last frame (the editor's own picture) is drawn: close once it is on screen. */
function landed(): void {
  requestAnimationFrame(() => setTimeout(close, 0));
  setTimeout(close, 120);
}
function startExit(): void {
  if (phase === 'exit') return;
  if (reduced || !S) { close(); return; }
  // Frames stop while the window is hidden or behind another one: land everything and close on time anyway.
  setTimeout(() => {
    if (closed) return;
    exit?.step(Infinity);
    clear(); drawChrome(1); for (const p of S.parts) glyph(p);
    close();
  }, EXIT_MAX_MS + 1500);
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
// Built once (only their text changes), so Back to code, beside the clock, keeps the keyboard.
const title = el('h1', D.scene === 'breathe' ? 'big' : '', ''), timer = el('span', 'timer', ''), hints = el('div', 'hints', '');
const clock = el('div', 'clock', '');
if (D.scene === 'breathe') { card.append(title); foot.append(timer, back); }
else { clock.append(timer, back); card.append(title, el('p', '', L.breakSub), clock, hints); }
function updateCard(t: number): void {
  const left = Math.max(0, D.seconds - Math.floor(t / 1000)), mmss = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  const key = `${D.scene === 'breathe' ? word : ''}${mmss}${pointer.seen ? 1 : 0}`;
  if (key !== shown) {
    shown = key;
    if (D.scene === 'breathe') { title.textContent = word; timer.textContent = `${L.breakSub} · ${mmss}`; }
    else {
      title.textContent = left ? L.breakTitle : L.breakDone;
      timer.textContent = mmss;
      hints.replaceChildren(...(D.scene === 'swarm' && !pointer.seen ? [el('p', 'small', L.moveMouse)] : []), ...(S.hint ? [el('p', 'small', S.hint)] : []));
    }
  }
  card.style.top = S.cardTop;
  card.style.opacity = String(clamp01((t - 300) / 400));
}

back.textContent = L.backBtn;
back.setAttribute('aria-label', L.back);
back.dataset.tip = L.back;
back.addEventListener('click', startExit);
addEventListener('keydown', (e) => { if (e.key === 'Escape') startExit(); });
cv.addEventListener('pointermove', (e) => {
  if (pointer.down && S?.drag && pointer.seen) S.drag(e.clientX - pointer.x, e.clientY - pointer.y);
  pointer.x = e.clientX; pointer.y = e.clientY; pointer.moved = true; pointer.seen = true; pointer.inside = true; pointer.at = performance.now(); kick();
});
cv.addEventListener('pointerleave', () => { if (!pointer.down) pointer.inside = false; });
document.documentElement.addEventListener('mouseleave', () => { if (!pointer.down) pointer.inside = false; });
addEventListener('blur', () => { if (!pointer.down) pointer.inside = false; });
cv.addEventListener('pointerdown', (e) => {
  pointer.down = true; pointer.x = e.clientX; pointer.y = e.clientY; pointer.seen = true; pointer.inside = true; pointer.at = performance.now();
  if (phase === 'run') S?.press?.();
  cv.setPointerCapture(e.pointerId); kick();
});
cv.addEventListener('pointerup', () => { pointer.down = false; kick(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) kick(); });

// the first frame is the code exactly where the editor draws it
clear();
if (reduced) {
  // reduced motion: the code stays still and dimmed, with the card; Esc or Back to code closes at once
  drawChrome(0.25);
  for (const p of chars) glyph(p, 0.25);
  title.textContent = L.breakTitle; timer.textContent = '';
  card.style.top = '45%'; card.style.opacity = '1';
} else {
  drawChrome(1);
  for (const p of chars) glyph(p);
}
// The tab loads behind the code: it says it's ready, VS Code brings it forward, then says "go".
let going = false;
const loadSize = `${innerWidth}x${innerHeight}`;
/** Run `f` once the tab has its real size: VS Code resizes it just after bringing it forward (or it already had it). */
function whenSized(f: () => void): void {
  let done = false;
  const run = () => { if (!done) { done = true; removeEventListener('resize', onResize); f(); } };
  const onResize = () => requestAnimationFrame(run);
  addEventListener('resize', onResize);
  const t0 = performance.now();
  const poll = () => { if (done) return; if (`${innerWidth}x${innerHeight}` !== loadSize || performance.now() - t0 > 250) run(); else requestAnimationFrame(poll); };
  requestAnimationFrame(poll);
}
addEventListener('message', (e: MessageEvent<{ type?: string }>) => {
  if (e.data?.type !== 'go' || going) return;
  going = true;
  // Until then the screen-sized first frame stays.
  whenSized(start);
});
function start(): void {
  // The real size now: redraw the first frame at once (same task, so no empty frame shows), then make the scene.
  W = innerWidth; H = innerHeight;
  size();
  clear();
  drawChrome(reduced ? 0.25 : 1);
  for (const p of chars) glyph(p, reduced ? 0.25 : p.a);
  // The keyboard starts on Back to code: Enter or Esc go back at once.
  back.focus();
  if (reduced) return;
  S = makeScene();
  tStart = performance.now();
  kick();
  // the countdown has its own tick: the loop sleeps when nothing moves (settled sand), the clock must not
  setInterval(() => { if (phase === 'run') updateCard(performance.now() - tStart); }, 1000);
}
vscode.postMessage({ type: 'ready', chars: chars.length });
