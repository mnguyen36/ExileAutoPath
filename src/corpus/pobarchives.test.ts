import { describe, it, expect } from "vitest";
import { extractBuildIds, extractPobbinId, looksLikeCode } from "./pobarchives.js";

describe("pobarchives extraction (pure)", () => {
  it("pulls unique build ids from listing HTML and respects the limit", () => {
    const html = `
      <a href="/build/PpAXAVQx">A</a>
      <a href="/build/GUnhnPJR">B</a>
      <a href="/build/PpAXAVQx">A again</a>
      <a href="/about">no</a>
      <a href="/build/c9iMNEcA">C</a>`;
    expect(extractBuildIds(html)).toEqual(["PpAXAVQx", "GUnhnPJR", "c9iMNEcA"]);
    expect(extractBuildIds(html, 2)).toEqual(["PpAXAVQx", "GUnhnPJR"]);
  });

  it("extracts the pobb.in id from a build page", () => {
    expect(extractPobbinId('... <a href="https://pobb.in/Q21REac9ve9a">PoB</a> ...')).toBe(
      "Q21REac9ve9a",
    );
    expect(extractPobbinId("<p>no link here</p>")).toBeNull();
  });

  it("prefers the full id over a truncated display reference", () => {
    const html = 'see pobb.in/S- ... canonical https://pobb.in/Q21REac9ve9a here';
    expect(extractPobbinId(html)).toBe("Q21REac9ve9a");
  });

  it("distinguishes a real code from an HTML error page", () => {
    expect(looksLikeCode("eNrt" + "A".repeat(300))).toBe(true);
    expect(looksLikeCode("<!DOCTYPE html><html>...")).toBe(false);
    expect(looksLikeCode("short")).toBe(false);
  });
});
