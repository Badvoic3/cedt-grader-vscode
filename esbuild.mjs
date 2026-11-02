// Bundles the extension host (dist/extension.js) and the sidebar webview
// (media/dist/webview.js + css + codicons). Usage: node esbuild.mjs [--watch] [--production]
import { context } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

const copyAssets = {
  name: 'copy-webview-assets',
  setup(build) {
    build.onEnd(async () => {
      await mkdir('media/dist', { recursive: true });
      await copyFile('node_modules/@vscode/codicons/dist/codicon.css', 'media/dist/codicon.css');
      await copyFile('node_modules/@vscode/codicons/dist/codicon.ttf', 'media/dist/codicon.ttf');
      await copyFile('webview/style.css', 'media/dist/webview.css');
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

if (watch) {
  await Promise.all([host.watch(), webview.watch()]);
} else {
  await Promise.all([host.rebuild(), webview.rebuild()]);
  await Promise.all([host.dispose(), webview.dispose()]);
}
