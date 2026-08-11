// Pure helpers: phone-destination normalization and OTP-message formatting.
// No I/O, no secrets, no logging -- kept separate from eskiz.ts/index.ts
// specifically so they're trivially unit-testable without a fake HTTP server.

const UZBEK_E164_BARE = /^998\d{9}$/;

// The hook payload's user.phone is expected to already be GoTrue's own
// bare-digit E.164 storage form (confirmed repeatedly against this project's
// backend: auth.users.phone is stored as "998XXXXXXXXX", no '+'), but this
// function must never trust that blindly -- it independently re-validates
// and normalizes to the exact bare-digit form Eskiz's mobile_phone field
// expects (OpenAPI example: "998991234567"). Accepts an optional leading
// '+' and strips non-digit characters defensively, then requires the result
// to match Uzbekistan's 998 + 9-digit form exactly. Anything else (missing,
// malformed, non-Uzbek) returns null -- callers must fail closed, never
// guess.
export function normalizeEskizDestination(rawPhone: unknown): string | null {
  if (typeof rawPhone !== "string") return null;
  const stripped = rawPhone.trim().replace(/[\s\-()]/g, "");
  const digits = stripped.startsWith("+") ? stripped.slice(1) : stripped;
  if (!/^\d+$/.test(digits)) return null;
  return UZBEK_E164_BARE.test(digits) ? digits : null;
}

const SIX_DIGIT_OTP = /^\d{6}$/;

// Defensive shape check only -- this function never generates or verifies
// an OTP itself. Supabase Auth remains the sole authority for OTP
// generation/verification; this just guards against formatting a malformed
// hook payload's otp field into an outgoing SMS.
export function isValidHookOtp(otp: unknown): otp is string {
  return typeof otp === "string" && SIX_DIGIT_OTP.test(otp);
}

// The code must come only from sms.otp (the caller's already-validated
// isValidHookOtp result) -- never synthesized here.
export function formatOtpMessage(otp: string): string {
  return `ZAYTUN GO ilovasi uchun kirish kodi: ${otp}`;
}
