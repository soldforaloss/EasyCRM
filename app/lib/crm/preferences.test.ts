import { describe, expect, it } from "vitest";
import {
  derivePreferences,
  parseSizeObservations,
  parseSizeToken,
  parseVariantTitle,
} from "./preferences";

describe("size token parsing", () => {
  it.each(["XXS", "xs", "S", "m", "L", "xl", "XXL", "xxxl", "2xl", "3XL", "4xl"])(
    "recognizes alpha shirt size %s case-insensitively",
    (value) => {
      expect(parseSizeToken(value)).toEqual({
        key: "SHIRT_SIZE",
        value: value.toUpperCase(),
      });
    },
  );

  it("recognizes whole and half shoe sizes and strips W/M suffixes", () => {
    expect(parseSizeToken("3.5")).toEqual({ key: "SHOE_SIZE", value: "3.5" });
    expect(parseSizeToken("18")).toEqual({ key: "SHOE_SIZE", value: "18" });
    expect(parseSizeToken("9.5W")).toEqual({ key: "SHOE_SIZE", value: "9.5" });
    expect(parseSizeToken("10m")).toEqual({ key: "SHOE_SIZE", value: "10" });
  });

  it("splits Shopify variant titles and ignores non-size tokens", () => {
    expect(parseVariantTitle("L / Blue")).toEqual([
      { key: "SHIRT_SIZE", value: "L" },
    ]);
    expect(parseVariantTitle("9.5 / White")).toEqual([
      { key: "SHOE_SIZE", value: "9.5" },
    ]);
    expect(parseVariantTitle("Blue / Wide")).toEqual([]);
  });

  it("rejects out-of-range, non-half-step and waist-like numeric values", () => {
    for (const value of ["3", "18.5", "9.25", "30", "32", "9 Wide", "W"]) {
      expect(parseSizeToken(value)).toBeNull();
    }
  });
});

describe("derivePreferences", () => {
  it("weights observations by purchased quantity", () => {
    expect(
      derivePreferences([
        { title: "Tee", variantTitle: "M / Black", quantity: 3 },
        { title: "Tee", variantTitle: "L / Blue", quantity: 2 },
        { title: "Sneaker", variantTitle: "10 / White", quantity: 1 },
      ]),
    ).toEqual([
      { key: "SHIRT_SIZE", value: "M", sampleCount: 3 },
      { key: "SHOE_SIZE", value: "10", sampleCount: 1 },
    ]);
  });

  it("breaks equal weighted totals in favor of the later purchase", () => {
    expect(
      derivePreferences([
        { title: "Old tee", variantTitle: "M", quantity: 2 },
        { title: "New tee", variantTitle: "L", quantity: 2 },
      ]),
    ).toEqual([{ key: "SHIRT_SIZE", value: "L", sampleCount: 2 }]);
  });

  it("returns no observations for empty, invalid or size-free items", () => {
    expect(parseSizeObservations([])).toEqual([]);
    expect(
      derivePreferences([
        { title: "Hat", variantTitle: null, quantity: 1 },
        { title: "Tee", variantTitle: "Blue / Cotton", quantity: 2 },
        { title: "Sneaker", variantTitle: "10", quantity: 0 },
        { title: "Jeans", variantTitle: "30 / 32", quantity: 1 },
      ]),
    ).toEqual([]);
  });
});
