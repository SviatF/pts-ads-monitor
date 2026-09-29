export type ReportPeriod = {
  start: Date;
  end: Date;
  title: string;
};

export function parseIsoDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

export function startOfMonth(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

export function endOfMonth(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
}

export function addMonths(date: Date, months: number) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
}

export function shortDate(date: Date) {
  return `${String(date.getUTCDate()).padStart(2, "0")}.${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function monthKey(date: Date) {
  return `${String(date.getUTCMonth() + 1).padStart(2, "0")}.${date.getUTCFullYear()}`;
}

export function fourPeriodsForMonth(month: Date): ReportPeriod[] {
  const year = month.getUTCFullYear();
  const monthIndex = month.getUTCMonth();
  const last = endOfMonth(month).getUTCDate();
  const boundaries = [
    [1, 7],
    [8, 15],
    [16, 22],
    [23, last],
  ] as const;

  return boundaries.map(([startDay, endDay]) => {
    const start = new Date(Date.UTC(year, monthIndex, startDay));
    const end = new Date(Date.UTC(year, monthIndex, endDay));
    return { start, end, title: `${shortDate(start)}–${shortDate(end)}` };
  });
}

export function periodForDate(date: Date): ReportPeriod {
  const periods = fourPeriodsForMonth(date);
  const period = periods.find((item) => date >= item.start && date <= item.end);
  if (!period) throw new Error(`No reporting period found for ${date.toISOString()}`);
  return period;
}

export function dayIndexInPeriod(date: Date, period: ReportPeriod) {
  return Math.floor((date.getTime() - period.start.getTime()) / 86_400_000);
}

export function periodLength(period: ReportPeriod) {
  return dayIndexInPeriod(period.end, period) + 1;
}

export function periodLengthFromTitle(title: string) {
  const match = title.match(/^(\d{2})\.(\d{2})[–-](\d{2})\.(\d{2})$/);
  if (!match) return null;
  const [, startDay, startMonth, endDay, endMonth] = match;
  if (startMonth !== endMonth) return null;
  return Number(endDay) - Number(startDay) + 1;
}
