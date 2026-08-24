import { useEffect, useRef } from "react";
import { getTelegramBackButton } from "./telegramMiniApp";

// Shows Telegram's native BackButton chrome while `active` is true and
// routes it through `onBack` -- used by the checkout wizard so the
// hardware/header back control steps backward through the wizard (and, on
// its first step, back to the cart) instead of falling through to
// whatever Telegram's default chrome would otherwise do. A ref holds the
// latest callback so onClick/offClick are registered by IDENTITY exactly
// once per mount, never re-registered on every render (same pattern as
// submitOrderRef in Checkout).
export function useTelegramBackButton(active: boolean, onBack: () => void): void {
  const onBackRef = useRef(onBack);
  useEffect(() => {
    onBackRef.current = onBack;
  }, [onBack]);
  useEffect(() => {
    const backButton = getTelegramBackButton();
    if (!backButton || !active) return;
    const handleClick = () => onBackRef.current();
    backButton.show();
    backButton.onClick(handleClick);
    return () => {
      backButton.offClick(handleClick);
      backButton.hide();
    };
  }, [active]);
}
