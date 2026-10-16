const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Escapes text for HTML content and double- or single-quoted attribute values. Every rendered string goes through it. */
export function esc(value: string | number): string {
  return String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

/** JSON for an inline `<script type="application/ld+json">` block: `<` is escaped so the data cannot close the tag. */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/[\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16)}`);
}
