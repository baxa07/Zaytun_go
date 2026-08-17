import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  cleanup();
  delete window.turnstile;
  document.querySelectorAll("script[data-zaytun-turnstile-script]").forEach((script) => script.remove());
  vi.resetModules();
});

describe("TurnstileWidget", () => {
  it("renders a verified token through the real externally-loaded API", async () => {
    const { TurnstileWidget } = await import("./TurnstileWidget");
    const onVerify = vi.fn();
    render(<TurnstileWidget siteKey="public-site-key" onVerify={onVerify} onExpire={vi.fn()} onError={vi.fn()} />);
    const script = document.querySelector<HTMLScriptElement>("script[data-zaytun-turnstile-script]");
    expect(script?.src).toBe("https://challenges.cloudflare.com/turnstile/v0/api.js");
    window.turnstile = {
      render: (_container, options) => { options.callback("captcha-token"); return "widget-1"; },
      remove: vi.fn(),
    };
    script?.onload?.(new Event("load"));
    await waitFor(() => expect(onVerify).toHaveBeenCalledWith("captcha-token"));
  });

  it("discards a failed singleton load so a visible remount retry can load a fresh script", async () => {
    const { TurnstileWidget } = await import("./TurnstileWidget");
    const firstError = vi.fn();
    const first = render(<TurnstileWidget siteKey="public-site-key" onVerify={vi.fn()} onExpire={vi.fn()} onError={firstError} />);
    const failedScript = document.querySelector<HTMLScriptElement>("script[data-zaytun-turnstile-script]");
    failedScript?.onerror?.(new Event("error"));
    await waitFor(() => expect(firstError).toHaveBeenCalledTimes(1));
    expect(document.querySelector("script[data-zaytun-turnstile-script]")).toBeNull();
    first.unmount();

    const onVerify = vi.fn();
    render(<TurnstileWidget siteKey="public-site-key" onVerify={onVerify} onExpire={vi.fn()} onError={vi.fn()} />);
    const retryScript = document.querySelector<HTMLScriptElement>("script[data-zaytun-turnstile-script]");
    expect(retryScript).not.toBeNull();
    expect(retryScript).not.toBe(failedScript);
    window.turnstile = {
      render: (_container, options) => { options.callback("retry-token"); return "widget-2"; },
      remove: vi.fn(),
    };
    retryScript?.onload?.(new Event("load"));
    await waitFor(() => expect(onVerify).toHaveBeenCalledWith("retry-token"));
  });
});
