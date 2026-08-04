/**
 * Pure size-preference derivation for this streetwear/sneaker merchant.
 *
 * Shopify joins variant option values with ` / `. Each token is considered independently:
 * exact apparel sizes (XXS through 4XL) become SHIRT_SIZE, while numeric values from 3.5 through
 * 18 in half-size steps become SHOE_SIZE after an optional W/M suffix is removed. Everything
 * else (colors, widths, waist sizes and arbitrary option text) is ignored.
 */

import {
  CONTACT_PREFERENCE_KEYS,
  type ContactPreferenceKey,
} from "./constants";

export interface PreferenceLineItem {
  title?: string | null;
  variantTitle?: string | null;
  quantity?: number | null;
}

export interface ParsedSizeToken {
  key: ContactPreferenceKey;
  value: string;
}

export interface SizeObservation extends ParsedSizeToken {
  quantity: number;
  occurrence: number;
}

export interface DerivedPreference extends ParsedSizeToken {
  sampleCount: number;
}

const SHIRT_SIZE_PATTERN = /^(XXS|XS|S|M|L|XL|XXL|XXXL|2XL|3XL|4XL)$/i;
const SHOE_SIZE_PATTERN = /^(\d+(?:\.\d+)?)(?:W|M)?$/i;

/** Classify one already-separated Shopify variant option token. */
export function parseSizeToken(token: string): ParsedSizeToken | null {
  const value = token.trim();
  if (!value) return null;

  if (SHIRT_SIZE_PATTERN.test(value)) {
    return { key: "SHIRT_SIZE", value: value.toUpperCase() };
  }

  const shoeMatch = SHOE_SIZE_PATTERN.exec(value);
  if (!shoeMatch) return null;
  const numericSize = Number(shoeMatch[1]);
  if (
    !Number.isFinite(numericSize) ||
    numericSize < 3.5 ||
    numericSize > 18 ||
    !Number.isInteger(numericSize * 2)
  ) {
    return null;
  }
  return { key: "SHOE_SIZE", value: String(numericSize) };
}

/** Split and classify every option token in one Shopify variant title. */
export function parseVariantTitle(
  variantTitle: string | null | undefined,
): ParsedSizeToken[] {
  if (typeof variantTitle !== "string" || !variantTitle.trim()) return [];
  return variantTitle.split(" / ").flatMap((token) => {
    const parsed = parseSizeToken(token);
    return parsed ? [parsed] : [];
  });
}

/** Convert valid, positively-quantified line items into weighted size observations. */
export function parseSizeObservations(
  lineItems: readonly PreferenceLineItem[],
): SizeObservation[] {
  const observations: SizeObservation[] = [];
  let occurrence = 0;

  for (const item of lineItems) {
    const quantity = item.quantity;
    if (!Number.isInteger(quantity) || (quantity ?? 0) <= 0) continue;
    for (const parsed of parseVariantTitle(item.variantTitle)) {
      observations.push({ ...parsed, quantity: quantity!, occurrence });
      occurrence += 1;
    }
  }

  return observations;
}

/**
 * Choose the most-observed value for each preference key, weighted by purchased quantity.
 * Equal totals prefer the later observation; callers supply line items oldest-first so a recent
 * purchase resolves the tie.
 */
export function derivePreferences(
  lineItems: readonly PreferenceLineItem[],
): DerivedPreference[] {
  const totals = new Map<
    ContactPreferenceKey,
    Map<string, { sampleCount: number; lastOccurrence: number }>
  >();

  for (const observation of parseSizeObservations(lineItems)) {
    const byValue = totals.get(observation.key) ?? new Map();
    const current = byValue.get(observation.value);
    byValue.set(observation.value, {
      sampleCount: (current?.sampleCount ?? 0) + observation.quantity,
      lastOccurrence: observation.occurrence,
    });
    totals.set(observation.key, byValue);
  }

  return CONTACT_PREFERENCE_KEYS.flatMap((key) => {
    const candidates = totals.get(key);
    if (!candidates) return [];
    const winner = [...candidates.entries()].sort(
      ([, a], [, b]) =>
        b.sampleCount - a.sampleCount || b.lastOccurrence - a.lastOccurrence,
    )[0];
    return winner
      ? [{ key, value: winner[0], sampleCount: winner[1].sampleCount }]
      : [];
  });
}
