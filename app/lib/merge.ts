/**
 * Merge-variable rendering for message templates and ad-hoc composition.
 *
 * Pure and dependency-free (unit-testable). Supports `{{ key }}` placeholders with optional
 * surrounding whitespace. Rendering is done server-side, per recipient, before sending.
 *
 * Design choices:
 *  - Unknown or empty variables render as an empty string (so customers never see raw
 *    `{{firstName}}`), and every referenced-but-missing key is reported in `missing` so the
 *    compose UI can warn the merchant.
 *  - Replacement values are inserted literally (these are SMS/plain or pre-escaped email
 *    bodies); callers are responsible for HTML-escaping when composing `htmlContent`.
 */

import type { MergeVars } from "./crm/types";

const PLACEHOLDER_RE = /\{\{\s*([\w.]+)\s*\}\}/g;

export interface MergeResult {
  text: string;
  /** Keys referenced by the template that were missing or empty in the context. */
  missing: string[];
}

/** Return the distinct variable keys referenced by a template, in first-seen order. */
export function extractVariables(template: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of template.matchAll(PLACEHOLDER_RE)) {
    const key = match[1];
    if (!seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}

function toValue(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  return v;
}

/** Render a template against a context, replacing `{{ key }}` placeholders. */
export function renderMerge(template: string, vars: MergeVars): MergeResult {
  const missing = new Set<string>();
  const text = template.replace(PLACEHOLDER_RE, (_full, key: string) => {
    const has = Object.prototype.hasOwnProperty.call(vars, key);
    const value = has ? toValue(vars[key]) : "";
    if (!has || value === "") {
      missing.add(key);
    }
    return value;
  });
  return { text, missing: [...missing] };
}

/** Convenience: render just the string (ignores the missing report). */
export function renderMergeText(template: string, vars: MergeVars): string {
  return renderMerge(template, vars).text;
}

/** Escape a string for safe interpolation into HTML email bodies. */
export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Render a plain-text body into a minimal, safe HTML body for Brevo `htmlContent`:
 * escapes HTML then converts newlines to <br>. Use when the merchant authored plain text.
 */
export function plainToHtml(text: string): string {
  return escapeHtml(text).replace(/\r?\n/g, "<br>");
}
