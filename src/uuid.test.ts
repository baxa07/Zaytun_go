import { afterEach, describe, expect, it, vi } from "vitest";
import { createUuid } from "./uuid";

const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, "crypto");

afterEach(() => {
  if (originalCrypto) Object.defineProperty(globalThis, "crypto", originalCrypto);
});

const installCrypto = (cryptoApi: Partial<Crypto>) => {
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: cryptoApi,
  });
};

describe("createUuid", () => {
  it("uses native randomUUID when available", () => {
    const expected = "12345678-1234-4123-8123-123456789abc";
    const randomUUID = vi.fn(() => expected);
    const getRandomValues = vi.fn();
    installCrypto({ randomUUID: randomUUID as Crypto["randomUUID"], getRandomValues: getRandomValues as Crypto["getRandomValues"] });

    expect(createUuid()).toBe(expected);
    expect(randomUUID).toHaveBeenCalledOnce();
    expect(getRandomValues).not.toHaveBeenCalled();
  });

  it("uses getRandomValues to produce an RFC 4122 UUID v4", () => {
    installCrypto({ getRandomValues: ((bytes: Uint8Array) => { bytes.set(Array.from({ length: 16 }, (_, index) => index)); return bytes; }) as Crypto["getRandomValues"] });

    expect(createUuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("produces different IDs across fallback calls", () => {
    let call = 0;
    installCrypto({ getRandomValues: ((bytes: Uint8Array) => { bytes.fill(call++); return bytes; }) as Crypto["getRandomValues"] });

    expect(createUuid()).not.toBe(createUuid());
  });
});
