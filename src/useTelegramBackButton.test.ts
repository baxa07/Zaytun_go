import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTelegramBackButton } from "./useTelegramBackButton";

afterEach(() => {
  delete window.Telegram;
});

const genuineWebApp = (backButton: { show: () => void; hide: () => void; onClick: (cb: () => void) => void; offClick: (cb: () => void) => void }) => ({
  initData: "auth_date=1&hash=signed",
  ready: vi.fn(),
  expand: vi.fn(),
  BackButton: backButton,
});

describe("useTelegramBackButton", () => {
  it("does nothing outside a genuine Telegram context", () => {
    const show = vi.fn();
    window.Telegram = { WebApp: { initData: "", ready: vi.fn(), expand: vi.fn(), BackButton: { show, hide: vi.fn(), onClick: vi.fn(), offClick: vi.fn() } } };
    renderHook(() => useTelegramBackButton(true, () => {}));
    expect(show).not.toHaveBeenCalled();
  });

  it("shows and registers onClick while active in a genuine Telegram context", () => {
    const show = vi.fn();
    const onClick = vi.fn();
    window.Telegram = { WebApp: genuineWebApp({ show, hide: vi.fn(), onClick, offClick: vi.fn() }) };
    renderHook(() => useTelegramBackButton(true, () => {}));
    expect(show).toHaveBeenCalledOnce();
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("never shows the button while inactive (e.g. checkout not mounted)", () => {
    const show = vi.fn();
    window.Telegram = { WebApp: genuineWebApp({ show, hide: vi.fn(), onClick: vi.fn(), offClick: vi.fn() }) };
    renderHook(() => useTelegramBackButton(false, () => {}));
    expect(show).not.toHaveBeenCalled();
  });

  it("hides and unregisters on unmount so it never lingers past the screen it was shown for", () => {
    const hide = vi.fn();
    const offClick = vi.fn();
    window.Telegram = { WebApp: genuineWebApp({ show: vi.fn(), hide, onClick: vi.fn(), offClick }) };
    const { unmount } = renderHook(() => useTelegramBackButton(true, () => {}));
    unmount();
    expect(hide).toHaveBeenCalledOnce();
    expect(offClick).toHaveBeenCalledOnce();
  });

  it("always invokes the LATEST onBack closure, not a stale one from first render", () => {
    let registeredClick: (() => void) | undefined;
    const onClick = (cb: () => void) => { registeredClick = cb; };
    window.Telegram = { WebApp: genuineWebApp({ show: vi.fn(), hide: vi.fn(), onClick, offClick: vi.fn() }) };
    const calls: string[] = [];
    const { rerender } = renderHook(({ onBack }) => useTelegramBackButton(true, onBack), {
      initialProps: { onBack: () => calls.push("first") },
    });
    rerender({ onBack: () => calls.push("second") });
    registeredClick?.();
    expect(calls).toEqual(["second"]);
  });
});
