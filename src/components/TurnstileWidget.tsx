import { useEffect, useRef } from "react";

// Cloudflare Turnstile, chosen over hCaptcha for the customer-OTP CAPTCHA
// gate: Turnstile's free tier includes its low-friction Managed/Invisible
// modes (hCaptcha reserves that for paid tiers), and its official test
// sitekeys work directly on localhost/127.0.0.1 with no hosts-file
// workaround, which is what makes this widget testable in this project's
// local Playwright suite at all.
interface TurnstileRenderOptions {
  sitekey: string;
  callback: (token: string) => void;
  "expired-callback"?: () => void;
  "error-callback"?: () => void;
}

interface TurnstileApi {
  render: (container: HTMLElement, options: TurnstileRenderOptions) => string;
  remove: (widgetId: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js";
// Module-level, not component-level: the script tag must only ever be
// injected once per page, no matter how many times this component mounts
// (e.g. across the widget's own key-based reset remounts).
let scriptLoadPromise: Promise<void> | null = null;

function loadTurnstileScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  if (!scriptLoadPromise) {
    scriptLoadPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = SCRIPT_SRC;
      script.async = true;
      script.defer = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("Turnstile script failed to load"));
      document.head.appendChild(script);
    });
  }
  return scriptLoadPromise;
}

// Deliberately no internal default/fallback sitekey -- a missing siteKey is
// the caller's responsibility to detect and handle (e.g. disable sending)
// rather than this component silently rendering nothing or a broken widget.
export function TurnstileWidget({
  siteKey,
  onVerify,
  onExpire,
  onError,
}: {
  siteKey: string;
  onVerify: (token: string) => void;
  onExpire: () => void;
  onError: () => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);
  const onVerifyRef = useRef(onVerify);
  const onExpireRef = useRef(onExpire);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onVerifyRef.current = onVerify;
    onExpireRef.current = onExpire;
    onErrorRef.current = onError;
  }, [onVerify, onExpire, onError]);

  useEffect(() => {
    let cancelled = false;
    loadTurnstileScript()
      .then(() => {
        if (cancelled || !containerRef.current || !window.turnstile) return;
        widgetIdRef.current = window.turnstile.render(containerRef.current, {
          sitekey: siteKey,
          callback: (token) => onVerifyRef.current(token),
          "expired-callback": () => onExpireRef.current(),
          "error-callback": () => onErrorRef.current(),
        });
      })
      .catch(() => onErrorRef.current());
    return () => {
      cancelled = true;
      if (widgetIdRef.current && window.turnstile) {
        window.turnstile.remove(widgetIdRef.current);
      }
    };
  }, [siteKey]);

  return <div ref={containerRef} data-testid="turnstile-widget" />;
}
