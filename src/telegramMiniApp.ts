type TelegramThemeParams = {
  bg_color?: string;
  text_color?: string;
  hint_color?: string;
  button_color?: string;
  button_text_color?: string;
  secondary_bg_color?: string;
  header_bg_color?: string;
};

type TelegramBackButton = {
  isVisible?: boolean;
  show(): void;
  hide(): void;
  onClick(callback: () => void): void;
  offClick(callback: () => void): void;
};

type TelegramWebApp = {
  initData?: string;
  platform?: string;
  colorScheme?: "light" | "dark";
  themeParams?: TelegramThemeParams;
  ready(): void;
  expand(): void;
  setHeaderColor?(color: string): void;
  setBackgroundColor?(color: string): void;
  BackButton?: TelegramBackButton;
};

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

const themeVariables: Array<[keyof TelegramThemeParams, string]> = [
  ["bg_color", "--tg-theme-bg-color"],
  ["text_color", "--tg-theme-text-color"],
  ["hint_color", "--tg-theme-hint-color"],
  ["button_color", "--tg-theme-button-color"],
  ["button_text_color", "--tg-theme-button-text-color"],
  ["secondary_bg_color", "--tg-theme-secondary-bg-color"],
  ["header_bg_color", "--tg-theme-header-bg-color"],
];

export function initializeTelegramMiniApp(): boolean {
  const webApp = window.Telegram?.WebApp;
  if (!webApp || !webApp.initData) return false;

  document.documentElement.classList.add("telegram-mini-app");
  document.documentElement.dataset.telegramPlatform = webApp.platform || "unknown";
  document.documentElement.dataset.telegramColorScheme = webApp.colorScheme || "light";

  for (const [source, target] of themeVariables) {
    const value = webApp.themeParams?.[source];
    if (value) document.documentElement.style.setProperty(target, value);
  }

  webApp.setHeaderColor?.("#ffffff");
  webApp.setBackgroundColor?.("#f7f6f2");
  webApp.expand();
  webApp.ready();
  return true;
}

// Same authenticity gate as initializeTelegramMiniApp (genuine initData
// only) -- BackButton is UI chrome, not an identity signal, but a mocked
// or embedded-without-initData window.Telegram object in a browser test
// must never activate real Telegram chrome either.
export function getTelegramBackButton(): TelegramBackButton | undefined {
  const webApp = window.Telegram?.WebApp;
  return webApp?.initData ? webApp.BackButton : undefined;
}

