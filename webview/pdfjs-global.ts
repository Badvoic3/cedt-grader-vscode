// Must be imported before pdfjs-dist/legacy/web/pdf_viewer.mjs, which reads `globalThis.pdfjsLib` at load time.
// The legacy build, like "Load sample cases" in the host: both use the one worker file in media/dist/pdfjs.
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

(globalThis as unknown as { pdfjsLib: typeof pdfjsLib }).pdfjsLib = pdfjsLib;

export { pdfjsLib };
