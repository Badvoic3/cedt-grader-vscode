// Bundles the extension host (dist/extension.js) and the sidebar webview
// (media/dist/webview.js + css + codicons). Usage: node esbuild.mjs [--watch] [--production]
import { context } from 'esbuild';
import { copyFile, cp, mkdir, rm } from 'node:fs/promises';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

// Production (the .vsix): start from empty output folders, so no source maps or
// other leftovers of a dev build are packaged (.vscodeignore re-includes all of media/dist).
if (production) {
  await rm('dist', { recursive: true, force: true });
  await rm('media/dist', { recursive: true, force: true });
}

// pdf.js legacy (Node) build for "Load sample cases" in the extension host: its own
// files, imported at runtime on first use (src/data/pdfSamples.ts), so they never weigh on activation.
const copyHostPdfjs = {
  name: 'copy-host-pdfjs',
  setup(build) {
    build.onEnd(async () => {
      await mkdir('dist/pdfjs', { recursive: true });
      for (const f of ['pdf.min.mjs', 'pdf.worker.min.mjs']) await copyFile(`node_modules/pdfjs-dist/legacy/build/${f}`, `dist/pdfjs/${f}`);
    });
  },
};

const copyAssets = {
  name: 'copy-webview-assets',
  setup(build) {
    build.onEnd(async () => {
      await mkdir('media/dist', { recursive: true });
      await copyFile('node_modules/@vscode/codicons/dist/codicon.css', 'media/dist/codicon.css');
      await copyFile('node_modules/@vscode/codicons/dist/codicon.ttf', 'media/dist/codicon.ttf');
      await copyFile('webview/style.css', 'media/dist/webview.css');
      await copyFile('webview/statement.css', 'media/dist/statement.css');
      // pdf.js assets for the statement viewer (bundled; never loaded from a CDN).
      const pdfjs = 'node_modules/pdfjs-dist';
      await mkdir('media/dist/pdfjs', { recursive: true });
      await copyFile(`${pdfjs}/build/pdf.worker.min.mjs`, 'media/dist/pdfjs/pdf.worker.min.mjs');
      await copyFile(`${pdfjs}/web/pdf_viewer.css`, 'media/dist/pdfjs/pdf_viewer.css');
      await cp(`${pdfjs}/web/images`, 'media/dist/pdfjs/images', { recursive: true });
      await cp(`${pdfjs}/cmaps`, 'media/dist/pdfjs/cmaps', { recursive: true });
      await cp(`${pdfjs}/standard_fonts`, 'media/dist/pdfjs/standard_fonts', { recursive: true });
    });
  },
};

const common = {
  bundle: true,
  minify: production,
  sourcemap: production ? false : 'linked',
  logLevel: 'info',
};

const host = await context({
  ...common,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  // Node reads the bundle as UTF-8: keep the Thai texts as they are (\uXXXX escapes made it 60 KB larger).
  charset: 'utf8',
  plugins: [copyHostPdfjs],
});

const webview = await context({
  ...common,
  entryPoints: ['webview/main.ts'],
  outfile: 'media/dist/webview.js',
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  plugins: [copyAssets],
});

const statement = await context({
  ...common,
  entryPoints: ['webview/statement.ts'],
  outfile: 'media/dist/statement.js',
  platform: 'browser',
  format: 'esm',
  // A module script is always decoded as UTF-8. (The sidebar's classic script stays ASCII-escaped:
  // its decoding would depend on the page encoding.)
  charset: 'utf8',
  target: 'es2022',
});

const all = [host, webview, statement];
if (watch) {
  await Promise.all(all.map((c) => c.watch()));
} else {
  await Promise.all(all.map((c) => c.rebuild()));
  await Promise.all(all.map((c) => c.dispose()));
}
