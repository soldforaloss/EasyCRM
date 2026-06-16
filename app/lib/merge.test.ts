import { describe, expect, it } from "vitest";
import {
  escapeHtml,
  extractVariables,
  plainToHtml,
  renderMerge,
  renderMergeText,
} from "./merge";

describe("merge.extractVariables", () => {
  it("returns distinct keys in first-seen order", () => {
    expect(
      extractVariables("Hi {{ firstName }}, {{firstName}} {{lastName}}!"),
    ).toEqual(["firstName", "lastName"]);
  });
  it("returns empty for no placeholders", () => {
    expect(extractVariables("no vars here")).toEqual([]);
  });
});

describe("merge.renderMerge", () => {
  it("replaces known variables", () => {
    const { text, missing } = renderMerge("Hi {{firstName}} {{lastName}}", {
      firstName: "Jordan",
      lastName: "Rivera",
    });
    expect(text).toBe("Hi Jordan Rivera");
    expect(missing).toEqual([]);
  });

  it("tolerates whitespace inside braces", () => {
    expect(renderMergeText("{{  firstName  }}", { firstName: "Sam" })).toBe(
      "Sam",
    );
  });

  it("renders missing/empty vars as empty and reports them", () => {
    const { text, missing } = renderMerge("Hi {{firstName}}!", {});
    expect(text).toBe("Hi !");
    expect(missing).toEqual(["firstName"]);
  });

  it("treats empty-string values as missing for reporting", () => {
    const { missing } = renderMerge("{{firstName}}", { firstName: "" });
    expect(missing).toEqual(["firstName"]);
  });

  it("coerces numbers", () => {
    expect(renderMergeText("Orders: {{ordersCount}}", { ordersCount: 3 })).toBe(
      "Orders: 3",
    );
  });

  it("ignores non-finite numbers", () => {
    expect(renderMergeText("{{n}}", { n: Number.NaN })).toBe("");
  });
});

describe("merge.escapeHtml / plainToHtml", () => {
  it("escapes HTML special chars", () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;",
    );
  });
  it("converts newlines to <br> after escaping", () => {
    expect(plainToHtml("a <b>\nc")).toBe("a &lt;b&gt;<br>c");
  });
});
