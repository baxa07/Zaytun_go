// Uzbek mobile phone normalization for driver login. Accepts the local
// 9-digit form, the 12-digit form with country code, and either of those
// with a leading '+', with spaces/dashes/parentheses stripped. Returns the
// canonical E.164 form (+998XXXXXXXXX) or null if the input isn't a
// recognizable Uzbek mobile number -- callers must not silently treat
// unrecognized text as a phone number.
//
// The '+'-prefixed E.164 form is safe to send straight to
// supabase.auth.signInWithPassword({ phone, ... }): GoTrue always stores
// auth.users.phone bare-digit internally (confirmed via the Admin API --
// creating a user with phone "+998901234567" results in a stored phone of
// "998901234567"), but its password sign-in endpoint normalizes the
// incoming `phone` parameter before matching, so both "+998901234567" and
// "998901234567" authenticate an Admin-API-created user identically. (An
// earlier, non-representative test that manually inserted a '+'-prefixed
// value directly into auth.users.phone -- bypassing GoTrue's own write-path
// normalization -- produced a stored value sign-in could never match,
// which had wrongly suggested stripping '+' was required.)
const UZBEK_LOCAL_DIGITS = 9;

export function normalizeUzbekPhone(raw: string): string | null {
  const stripped = raw.trim().replace(/[\s\-()]/g, "");
  if (!/^\+?\d+$/.test(stripped)) return null;
  const digits = stripped.startsWith("+") ? stripped.slice(1) : stripped;
  if (digits.length === UZBEK_LOCAL_DIGITS) return `+998${digits}`;
  if (digits.length === UZBEK_LOCAL_DIGITS + 3 && digits.startsWith("998")) {
    return `+998${digits.slice(3)}`;
  }
  return null;
}

// Lenient companion to normalizeUzbekPhone, for a live/incremental input
// (the guest checkout phone field's fixed "+998" prefix + editable
// national-number box): always returns 0-9 national digits, never null,
// so it can run on every keystroke including partial input -- callers
// decide what "complete" means (exactly 9 digits) themselves.
//
// An explicit '+998' prefix is unambiguous regardless of how many digits
// follow, so it correctly round-trips a value this same field already
// stored mid-typing (e.g. "+99890" -> "90"), not just a fully-typed one.
// Without an explicit '+', a bare 12-digit string starting with "998" is
// treated as a country-code-prefixed paste; anything else (9 or fewer
// digits, including ones that happen to start with "998" -- "99" is
// itself a valid Uzbek operator code, so e.g. "998123456" is a genuine,
// unrelated national number) is treated as national digits verbatim, so
// real character-by-character typing is never misinterpreted.
export function extractUzbekNationalDigits(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("+998")) {
    return trimmed.slice(4).replace(/\D/g, "").slice(0, UZBEK_LOCAL_DIGITS);
  }
  if (trimmed.startsWith("+")) return "";
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === UZBEK_LOCAL_DIGITS + 3 && digits.startsWith("998")) {
    return digits.slice(3);
  }
  return digits.slice(0, UZBEK_LOCAL_DIGITS);
}
