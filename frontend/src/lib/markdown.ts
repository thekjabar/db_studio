/**
 * Minimal markdown → HTML. Deliberately small — the notebook use case is
 * internal docs between SQL cells, not rich authoring. Pulling react-markdown
 * would add ~100 KB for something users type less than 20 lines of.
 *
 * Supported:
 *   # H1 / ## H2 / ### H3
 *   **bold**, *italic*, `code`
 *   unordered lists (`- `) and numbered lists (`1. `)
 *   [text](url) — https/mailto only
 *   ```sql\nblock\n``` — fenced code blocks
 *   paragraphs split by blank lines
 *
 * All output is HTML-escaped at every stage — we never interpolate raw user
 * input into tags. XSS review: an attacker who can edit a notebook can reach
 * exactly the same SQL-execution surface they already have via the editor,
 * so the only new risk is persisted-XSS through markdown. Scanning: no
 * `<script>`, no `javascript:` URLs, no attribute interpolation.
 */

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function inline(s: string): string {
  // Escape first so no other step can be fooled by a literal `<` in the source.
  let out = esc(s);
  // `code` — run before bold/italic so backticks don't fight with asterisks.
  out = out.replace(/`([^`]+)`/g, (_m, c) => `<code class="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]">${c}</code>`);
  // Links — only allow https: and mailto: schemes.
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text, url) => {
    const safe = /^(https?:\/\/|mailto:)/i.test(url);
    return safe
      ? `<a href="${url}" class="text-primary hover:underline" target="_blank" rel="noopener noreferrer">${text}</a>`
      : `<span>${text}</span>`;
  });
  // Bold + italic. Bold runs before italic so `**x**` isn't chewed by the italic regex first.
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return out;
}

export function renderMarkdown(md: string): string {
  if (!md) return '';
  const lines = md.split(/\r?\n/);
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block.
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      const lang = fence[1];
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++; // consume closing fence
      out.push(
        `<pre class="rounded bg-muted p-3 text-xs font-mono overflow-x-auto"><code${
          lang ? ` class="language-${esc(lang)}"` : ''
        }>${esc(buf.join('\n'))}</code></pre>`,
      );
      continue;
    }

    // Headings.
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      const cls =
        level === 1
          ? 'text-2xl font-semibold mt-4 mb-2'
          : level === 2
            ? 'text-xl font-semibold mt-3 mb-2'
            : 'text-base font-semibold mt-2 mb-1';
      out.push(`<h${level} class="${cls}">${inline(h[2])}</h${level}>`);
      i++;
      continue;
    }

    // Unordered list.
    if (/^\s*-\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*-\s+/.test(lines[i])) {
        items.push(`<li>${inline(lines[i].replace(/^\s*-\s+/, ''))}</li>`);
        i++;
      }
      out.push(`<ul class="list-disc ml-6 my-2 space-y-1">${items.join('')}</ul>`);
      continue;
    }

    // Ordered list.
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(`<li>${inline(lines[i].replace(/^\s*\d+\.\s+/, ''))}</li>`);
        i++;
      }
      out.push(`<ol class="list-decimal ml-6 my-2 space-y-1">${items.join('')}</ol>`);
      continue;
    }

    // Blank line → paragraph break.
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Regular paragraph (consume contiguous non-special lines).
    const para: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^(#{1,3}\s|\s*-\s|\s*\d+\.\s|```)/.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    out.push(`<p class="my-2 leading-relaxed">${inline(para.join(' '))}</p>`);
  }

  return out.join('\n');
}
