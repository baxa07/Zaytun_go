export const OPERATIONAL_TIME_ZONE = "Asia/Tashkent";

const format = (value: string | Date, options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat("uz-UZ", { ...options, timeZone: OPERATIONAL_TIME_ZONE }).format(
    value instanceof Date ? value : new Date(value),
  );

export const formatOperationalTime = (value: string | Date) =>
  format(value, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

export const formatOperationalDateTime = (value: string | Date) =>
  format(value, { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

export const formatOperationalHeaderDate = (value: string | Date) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: OPERATIONAL_TIME_ZONE,
    day: "numeric",
    month: "numeric",
    year: "numeric",
  }).formatToParts(value instanceof Date ? value : new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value || "";
  const year = Number(part("year"));
  const month = Number(part("month"));
  const day = Number(part("day"));
  const weekdays = ["YAKSHANBA", "DUSHANBA", "SESHANBA", "CHORSHANBA", "PAYSHANBA", "JUMA", "SHANBA"];
  const months = ["YANVAR", "FEVRAL", "MART", "APREL", "MAY", "IYUN", "IYUL", "AVGUST", "SENTYABR", "OKTYABR", "NOYABR", "DEKABR"];
  const weekday = weekdays[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  return `${weekday} · ${day} ${months[month - 1]}`;
};
