import { describe, expect, it } from "vitest";
import { extractUzbekNationalDigits, normalizeUzbekPhone } from "./phone";

describe("normalizeUzbekPhone", () => {
  it("normalizes the local 9-digit form", () => {
    expect(normalizeUzbekPhone("901234567")).toBe("+998901234567");
  });

  it("normalizes the spaced local form", () => {
    expect(normalizeUzbekPhone("90 123 45 67")).toBe("+998901234567");
  });

  it("normalizes the 12-digit form with country code", () => {
    expect(normalizeUzbekPhone("998901234567")).toBe("+998901234567");
  });

  it("normalizes the '+'-prefixed E.164 form", () => {
    expect(normalizeUzbekPhone("+998901234567")).toBe("+998901234567");
  });

  it("normalizes a dashed variant", () => {
    expect(normalizeUzbekPhone("90-123-45-67")).toBe("+998901234567");
  });

  it("normalizes a spaced '+'-prefixed variant with parentheses", () => {
    expect(normalizeUzbekPhone("+998 (90) 123-45-67")).toBe("+998901234567");
  });

  it("rejects a number that is too short", () => {
    expect(normalizeUzbekPhone("12345")).toBeNull();
  });

  it("rejects a number that is too long", () => {
    expect(normalizeUzbekPhone("9012345678901")).toBeNull();
  });

  it("rejects a 12-digit number with the wrong country code", () => {
    expect(normalizeUzbekPhone("799901234567")).toBeNull();
  });

  it("does not silently treat arbitrary non-phone text as a phone number", () => {
    expect(normalizeUzbekPhone("restaurant@zaytun.local")).toBeNull();
    expect(normalizeUzbekPhone("not-a-phone")).toBeNull();
    expect(normalizeUzbekPhone("")).toBeNull();
    expect(normalizeUzbekPhone("abcdefghi")).toBeNull();
  });
});

describe("extractUzbekNationalDigits (fixed +998 prefix checkout phone field)", () => {
  it("passes through digits typed one at a time, never guessing early", () => {
    expect(extractUzbekNationalDigits("9")).toBe("9");
    expect(extractUzbekNationalDigits("90")).toBe("90");
    expect(extractUzbekNationalDigits("901")).toBe("901");
    expect(extractUzbekNationalDigits("901234567")).toBe("901234567");
  });

  it("a national number that itself starts with '998' (operator code 99 + a subscriber digit) is never mistaken for a country-code prefix", () => {
    expect(extractUzbekNationalDigits("998123456")).toBe("998123456");
  });

  it("normalizes a full '+998...' paste", () => {
    expect(extractUzbekNationalDigits("+998901234567")).toBe("901234567");
  });

  it("normalizes a bare '998...' paste (no leading +)", () => {
    expect(extractUzbekNationalDigits("998901234567")).toBe("901234567");
  });

  it("normalizes a formatted '+998 90 123 45 67' paste", () => {
    expect(extractUzbekNationalDigits("+998 90 123 45 67")).toBe("901234567");
  });

  it("normalizes formatting without a leading + (spaces/dashes/parens)", () => {
    expect(extractUzbekNationalDigits("998 (90) 123-45-67")).toBe("901234567");
  });

  it("round-trips a value this same field already stored mid-typing (a partial '+998' prefixed value), never re-stripping digits that were already national-only", () => {
    expect(extractUzbekNationalDigits("+99890123")).toBe("90123");
  });

  it("never produces a duplicated prefix or exceeds 9 digits even given excess input", () => {
    expect(extractUzbekNationalDigits("+998901234567890")).toBe("901234567");
    expect(extractUzbekNationalDigits(extractUzbekNationalDigits("+998901234567"))).toBe("901234567");
  });

  it("an explicit non-Uzbek country code is not guessed at", () => {
    expect(extractUzbekNationalDigits("+17995551234")).toBe("");
  });

  it("empty input produces empty digits", () => {
    expect(extractUzbekNationalDigits("")).toBe("");
  });
});
