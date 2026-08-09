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
