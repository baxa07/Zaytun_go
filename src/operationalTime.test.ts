import { describe, expect, it } from "vitest";
import { formatOperationalDateTime, formatOperationalHeaderDate, formatOperationalTime, OPERATIONAL_TIME_ZONE } from "./operationalTime";

describe("operational timestamps", () => {
  it("always uses Asia/Tashkent", () => {
    expect(OPERATIONAL_TIME_ZONE).toBe("Asia/Tashkent");
    expect(formatOperationalTime("2026-08-17T18:30:00Z")).toBe("23:30");
  });
  it("crosses the Tashkent date boundary correctly", () => {
    expect(formatOperationalDateTime("2026-08-17T20:30:00Z")).toMatch(/18[./]08[./]2026.*01:30/);
  });
  it("is independent of the device timezone", () => {
    expect(formatOperationalTime(new Date("2026-01-01T00:15:00+01:00"))).toBe("04:15");
  });
  it("renders the real Tashkent operational day instead of a fixture date", () => {
    expect(formatOperationalHeaderDate("2026-08-18T07:00:00Z")).toBe("SESHANBA · 18 AVGUST");
  });
  it("uses the instant, not the viewing device timezone, for the operational header", () => {
    expect(formatOperationalHeaderDate("2026-08-17T21:30:00+02:00")).toBe("SESHANBA · 18 AVGUST");
  });
  it("changes at midnight in Tashkent", () => {
    expect(formatOperationalHeaderDate("2026-08-17T18:59:59Z")).toBe("DUSHANBA · 17 AVGUST");
    expect(formatOperationalHeaderDate("2026-08-17T19:00:00Z")).toBe("SESHANBA · 18 AVGUST");
  });
});
