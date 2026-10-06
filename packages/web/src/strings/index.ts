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

export function formatTime(ts: number): string { return timeFormat.format(new Date(ts * 1000)); }
export function formatDay(ts: number): string { return dayFormat.format(new Date(ts * 1000)); }
