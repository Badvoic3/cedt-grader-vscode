import * as cheerio from 'cheerio/slim';
import MarkdownIt from 'markdown-it';

/** Raw HTML is disabled: markdown-it escapes it, so the output is safe to insert. */
const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

/** A text statement as safe HTML. Loaded on first use: only problems without a PDF need it. */
export function descriptionHtml(text: string, markdown: boolean): string {
  if (markdown) return md.render(text);
  // Non-markdown descriptions are HTML written for the website: show their text only.
  const $ = cheerio.load(text.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d|tr)>/gi, '$&\n'));
  return `<pre class="text">${md.utils.escapeHtml($.root().text().trim())}</pre>`;
}
