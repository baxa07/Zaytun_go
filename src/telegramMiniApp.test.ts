import { afterEach, describe, expect, it, vi } from "vitest";
import { initializeTelegramMiniApp } from "./telegramMiniApp";

afterEach(() => {
  delete window.Telegram;
  document.documentElement.className = "";
  document.documentElement.removeAttribute("data-telegram-platform");
  document.documentElement.removeAttribute("data-telegram-color-scheme");
  document.documentElement.removeAttribute("style");
  window.history.replaceState({}, "", "/");
});

describe("Telegram Mini App bridge", () => {
  it("does nothing in an ordinary browser", () => {
    expect(initializeTelegramMiniApp()).toBe(false);
    expect(document.documentElement.classList.contains("telegram-mini-app")).toBe(false);
  });

  it("initializes only when Telegram supplies signed initData", () => {
    const ready = vi.fn();
    const expand = vi.fn();
    const setHeaderColor = vi.fn();
    const setBackgroundColor = vi.fn();
    window.Telegram = { WebApp: {
      initData: "auth_date=1&hash=signed",
      platform: "ios",
      colorScheme: "dark",
      themeParams: { bg_color: "#111111", text_color: "#eeeeee" },
      ready,
      expand,
      setHeaderColor,
      setBackgroundColor,
    } };

    expect(initializeTelegramMiniApp()).toBe(true);
    expect(document.documentElement.classList.contains("telegram-mini-app")).toBe(true);
    expect(document.documentElement.dataset.telegramPlatform).toBe("ios");
    expect(document.documentElement.style.getPropertyValue("--tg-theme-bg-color")).toBe("#111111");
    expect(expand).toHaveBeenCalledOnce();
    expect(ready).toHaveBeenCalledOnce();
    expect(setHeaderColor).toHaveBeenCalledWith("#ffffff");
    expect(setBackgroundColor).toHaveBeenCalledWith("#f7f6f2");
  });

  it("does not treat the presence of the SDK alone as authenticated Telegram context", () => {
    window.Telegram = { WebApp: { initData: "", ready: vi.fn(), expand: vi.fn() } };
    expect(initializeTelegramMiniApp()).toBe(false);
  });

  it("uses the full-screen map-safe Telegram treatment for the Driver Mini App", () => {
    window.history.replaceState({}, "", "/driver");
    const disableVerticalSwipes = vi.fn();
    const requestFullscreen = vi.fn();
    const setHeaderColor = vi.fn();
    const setBackgroundColor = vi.fn();
    const setBottomBarColor = vi.fn();
    window.Telegram = { WebApp: {
      initData: "auth_date=1&hash=signed",
      ready: vi.fn(),
      expand: vi.fn(),
      disableVerticalSwipes,
      requestFullscreen,
      setHeaderColor,
      setBackgroundColor,
      setBottomBarColor,
    } };

    expect(initializeTelegramMiniApp()).toBe(true);
    expect(document.documentElement.classList.contains("telegram-driver-mini-app")).toBe(true);
    expect(setHeaderColor).toHaveBeenCalledWith("#244b36");
    expect(setBackgroundColor).toHaveBeenCalledWith("#f1f3f1");
    expect(setBottomBarColor).toHaveBeenCalledWith("#244b36");
    expect(disableVerticalSwipes).toHaveBeenCalledOnce();
    expect(requestFullscreen).toHaveBeenCalledOnce();
  });
});
