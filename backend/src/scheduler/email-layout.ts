/**
 * Shared, modern HTML email layout. All transactional emails render through
 * this so they look consistent and branded. Built with table-based markup +
 * inline styles — the only thing that renders reliably across Gmail, Outlook,
 * Apple Mail, etc. (no flexbox/grid, no <style> blocks dropped by clients).
 *
 * Dark, premium look matching the Query Schema brand (green #3ECF8E accent).
 */

const BRAND = 'Query Schema';
const ACCENT = '#3ECF8E';
const BG = '#0c0e0d';
const CARD = '#15181a';
const BORDER = '#262b29';
const TEXT = '#e6eae8';
const MUTED = '#8a938f';

export interface EmailContent {
  /** Big heading at the top of the card. */
  title: string;
  /** Intro paragraph(s) — plain text; newlines become paragraph breaks. */
  intro?: string;
  /** Optional call-to-action button. */
  button?: { label: string; url: string };
  /** Optional secondary note shown under the button (e.g. expiry). */
  note?: string;
  /** Optional raw HTML block inserted into the card (e.g. a result table). */
  html?: string;
  /** Footer line; defaults to brand + year. */
  footer?: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Wrap content in the branded email shell. */
export function renderEmail(c: EmailContent): string {
  const year = 2026; // stamped at build; avoids Date.now() in pure layout
  const paras = (c.intro ?? '')
    .split('\n')
    .filter((l) => l.trim())
    .map(
      (l) =>
        `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:${TEXT};">${escapeHtml(l)}</p>`,
    )
    .join('');

  const button = c.button
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 4px;">
         <tr><td style="border-radius:10px;background:${ACCENT};">
           <a href="${c.button.url}" style="display:inline-block;padding:13px 28px;font-size:15px;font-weight:600;color:#06120c;text-decoration:none;border-radius:10px;">${escapeHtml(c.button.label)}</a>
         </td></tr>
       </table>`
    : '';

  const note = c.note
    ? `<p style="margin:16px 0 0;font-size:13px;line-height:1.5;color:${MUTED};">${escapeHtml(c.note)}</p>`
    : '';

  const extra = c.html ?? '';
  const footer = c.footer ?? `© ${year} ${BRAND}`;

  return `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${BG};-webkit-font-smoothing:antialiased;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG};padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;">
        <!-- Brand header -->
        <tr><td style="padding:0 4px 20px;">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr>
            <td style="vertical-align:middle;">
              <!-- App logo: green circle with a white play triangle. Built with
                   a CSS border-triangle (no image/SVG) so it renders in Gmail
                   etc. The triangle is centered in a 30px circle. -->
              <table role="presentation" cellpadding="0" cellspacing="0" style="width:30px;height:30px;border-radius:50%;background:${ACCENT};">
                <tr><td align="center" style="vertical-align:middle;text-align:center;">
                  <span style="display:inline-block;width:0;height:0;border-style:solid;border-width:6px 0 6px 10px;border-color:transparent transparent transparent #06120c;margin-left:2px;"></span>
                </td></tr>
              </table>
            </td>
            <td style="vertical-align:middle;padding-left:10px;font-size:16px;font-weight:600;color:${TEXT};font-family:Inter,Segoe UI,Helvetica,Arial,sans-serif;">${BRAND}</td>
          </tr></table>
        </td></tr>
        <!-- Card -->
        <tr><td style="background:${CARD};border:1px solid ${BORDER};border-radius:16px;padding:32px;font-family:Inter,Segoe UI,Helvetica,Arial,sans-serif;">
          <h1 style="margin:0 0 16px;font-size:21px;line-height:1.3;color:${TEXT};font-weight:600;">${escapeHtml(c.title)}</h1>
          ${paras}
          ${button}
          ${note}
          ${extra}
        </td></tr>
        <!-- Footer -->
        <tr><td style="padding:20px 4px 0;text-align:center;font-family:Inter,Segoe UI,Helvetica,Arial,sans-serif;">
          <p style="margin:0;font-size:12px;color:${MUTED};">${escapeHtml(footer)}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}
