import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ gfm: true, breaks: true });

/** Delegates' text is untrusted: render it, then strip anything executable. */
export function renderMarkdown(source) {
  return DOMPurify.sanitize(marked.parse(source || ''), { USE_PROFILES: { html: true } });
}
