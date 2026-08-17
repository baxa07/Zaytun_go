export const OPERATIONAL_TIME_ZONE = "Asia/Tashkent";

const format = (value: string | Date, options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat("uz-UZ", { ...options, timeZone: OPERATIONAL_TIME_ZONE }).format(
    value instanceof Date ? value : new Date(value),
  );

export const formatOperationalTime = (value: string | Date) =>
  format(value, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

export const formatOperationalDateTime = (value: string | Date) =>
  format(value, { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
