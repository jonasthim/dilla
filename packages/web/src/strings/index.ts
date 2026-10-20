import { en } from './en.ts';
export { en } from './en.ts';
export type StringKey = keyof typeof en;

export function t(key: StringKey, vars?: Record<string, string | number>): string {
  return en[key].replace(/\{([a-zA-Z]+)\}/g, (_, name: string) => {
    if (vars?.[name] === undefined) throw new Error(`strings: ${key} needs {${name}}`);
    return String(vars[name]);
  });
}

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const dayFormat = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const dayTimeFormat = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export function formatTime(ts: number): string { return timeFormat.format(new Date(ts * 1000)); }
/**
 * The time for a grouped row's gutter: the locale's short hour and minute with the day period cut to its first letter and
 * set against the digits, so "12:59 PM" reads "12:59p" and "23:59" stays as it is. Six characters at most in en-US and en-GB.
 * `locale` is for tests; the app uses the browser's.
 */
export function formatGutterTime(ts: number, locale?: string): string {
  const parts = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).formatToParts(new Date(ts * 1000));
  return parts.map((part, i) => {
    if (part.type === 'dayPeriod') return [...part.value][0]?.toLowerCase() ?? '';
    // The space before the day period goes; a literal between the digits (the colon) stays.
    if (part.type === 'literal' && parts[i + 1]?.type === 'dayPeriod') return '';
    return part.value;
  }).join('');
}
export function formatDay(ts: number): string { return dayFormat.format(new Date(ts * 1000)); }
export function formatDayTime(ts: number): string { return dayTimeFormat.format(new Date(ts * 1000)); }
