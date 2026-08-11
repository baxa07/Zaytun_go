import { assertEquals } from "jsr:@std/assert@1";
import { formatOtpMessage, isValidHookOtp, normalizeEskizDestination } from "./message.ts";

Deno.test("normalizeEskizDestination: accepts bare-digit 998 form (GoTrue's own storage form)", () => {
  assertEquals(normalizeEskizDestination("998901234567"), "998901234567");
});

Deno.test("normalizeEskizDestination: accepts a leading '+' defensively", () => {
  assertEquals(normalizeEskizDestination("+998901234567"), "998901234567");
});

Deno.test("normalizeEskizDestination: strips spaces/dashes/parens defensively", () => {
  assertEquals(normalizeEskizDestination("+998 (90) 123-45-67"), "998901234567");
});

Deno.test("normalizeEskizDestination: rejects a non-Uzbek country code", () => {
  assertEquals(normalizeEskizDestination("15551234567"), null);
});

Deno.test("normalizeEskizDestination: rejects too short / too long", () => {
  assertEquals(normalizeEskizDestination("99890123"), null);
  assertEquals(normalizeEskizDestination("9989012345678"), null);
});

Deno.test("normalizeEskizDestination: rejects non-numeric garbage", () => {
  assertEquals(normalizeEskizDestination("not-a-phone"), null);
  assertEquals(normalizeEskizDestination(""), null);
});

Deno.test("normalizeEskizDestination: rejects non-string input", () => {
  assertEquals(normalizeEskizDestination(undefined), null);
  assertEquals(normalizeEskizDestination(null), null);
  assertEquals(normalizeEskizDestination(12345), null);
});

Deno.test("isValidHookOtp: accepts exactly 6 digits", () => {
  assertEquals(isValidHookOtp("123456"), true);
});

Deno.test("isValidHookOtp: rejects wrong length, non-digits, non-string", () => {
  assertEquals(isValidHookOtp("12345"), false);
  assertEquals(isValidHookOtp("1234567"), false);
  assertEquals(isValidHookOtp("12345a"), false);
  assertEquals(isValidHookOtp(123456), false);
  assertEquals(isValidHookOtp(undefined), false);
});

Deno.test("formatOtpMessage: builds the exact expected message (Eskiz operator-template format)", () => {
  assertEquals(formatOtpMessage("123456"), "ZAYTUN GO ilovasi uchun kirish kodi: 123456");
});

Deno.test("formatOtpMessage: interpolates the otp verbatim -- no mutation, no leading-zero loss", () => {
  assertEquals(formatOtpMessage("000000"), "ZAYTUN GO ilovasi uchun kirish kodi: 000000");
  assertEquals(formatOtpMessage("998877"), "ZAYTUN GO ilovasi uchun kirish kodi: 998877");
});

Deno.test("formatOtpMessage: only the otp varies between calls -- rest of the message is a fixed constant", () => {
  const a = formatOtpMessage("111111");
  const b = formatOtpMessage("222222");
  assertEquals(a.replace("111111", "X"), b.replace("222222", "X"));
});

Deno.test("formatOtpMessage: no extra whitespace or newlines", () => {
  const message = formatOtpMessage("123456");
  assertEquals(message, message.trim());
  assertEquals(message.includes("\n"), false);
  assertEquals(message.includes("  "), false);
});

Deno.test("formatOtpMessage: takes no sender-name parameter -- sender is not this function's concern", () => {
  assertEquals(formatOtpMessage.length, 1);
});
