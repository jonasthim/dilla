import { describe, it, expect, vi, afterEach } from 'vitest';
import { askPermission, notificationApi, readPermission, type NotificationApi } from './notify-permission.ts';

afterEach(() => { vi.unstubAllGlobals(); });

function api(permission: NotificationPermission, answer: NotificationPermission | Error): NotificationApi & { asked: number } {
  const fake = {
    permission, asked: 0,
    requestPermission(): Promise<NotificationPermission> {
      fake.asked += 1;
      if (answer instanceof Error) return Promise.reject(answer);
      fake.permission = answer;
      return Promise.resolve(answer);
    },
  };
  return fake;
}

describe('notification permission', () => {
  it('reads the browser state, and unsupported without the API', () => {
    expect(readPermission(api('default', 'granted'))).toBe('default');
    expect(readPermission(api('denied', 'denied'))).toBe('denied');
    expect(readPermission(undefined)).toBe('unsupported');
  });
  it('asks only when called, and answers what the browser decided', async () => {
    const a = api('default', 'granted');
    expect(a.asked).toBe(0);
    expect(await askPermission(a)).toBe('granted');
    expect(a.asked).toBe(1);
    const refused = api('default', new Error('no gesture'));
    expect(await askPermission(refused)).toBe('default');
    expect(await askPermission(undefined)).toBe('unsupported');
  });
  it('finds the global API, and none where the browser has none', () => {
    expect(notificationApi()).toBeUndefined();
    const a = api('granted', 'granted');
    vi.stubGlobal('Notification', a);
    expect(notificationApi()).toBe(a);
    expect(readPermission()).toBe('granted');
  });
});
