import { describe, expect, it } from "vitest";
import { normalizeUzbekPhone } from "./phone";

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
