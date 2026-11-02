// Must be imported before pdfjs-dist/web/pdf_viewer.mjs, which reads `globalThis.pdfjsLib` at load time.
import * as pdfjsLib from 'pdfjs-dist';

(globalThis as unknown as { pdfjsLib: typeof pdfjsLib }).pdfjsLib = pdfjsLib;

export { pdfjsLib };
