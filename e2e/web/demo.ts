// `npm run demo:web -w @dilla/e2e` (task 25; plan head ruling 41). The test host serves the built client on
// 127.0.0.1:8463 and one native peer owns a server named "demo" with the channel #general. Open the
// printed link, sign up with the peer's server invite, and the peer answers every message with
// "echo: <message>". web-1 creates no server of its own, so this is how a person walks the slice by hand.
// With DILLA_DEMO_CHECK=1 it ends after its first sync (task 25's gate). It requests neither `page` nor
// `context`, so Playwright launches no browser.
import { test, expect } from '@playwright/test';
import { WebDriver } from './support/driver';

interface DemoSetup { username: string; device_id: string; invite_code: string }
interface DemoMessage { body: string; sender_device: string }

/** Under the core's 4000-byte body limit (L-CORE-09) with room for the prefix. */
const ECHO_MAX_BYTES = 3900;
const POLL_MS = 1000;

/** `echo: <body>`, cut to at most ECHO_MAX_BYTES UTF-8 bytes without splitting a character. */
function echoOf(body: string): string {
  const encoder = new TextEncoder();
  let out = '';
  let bytes = 0;
  for (const ch of `echo: ${body}`) {
    const n = encoder.encode(ch).length;
    if (bytes + n > ECHO_MAX_BYTES) break;
    out += ch;
    bytes += n;
  }
  return out;
}

test('a peer to talk to', async () => {
  const host = process.env.DILLA_TEST_HOST;
  const invite = process.env.DILLA_TESTKIT_INVITE;
  const control = process.env.DILLA_TESTKIT_CONTROL;
  if (!host || !invite || !control) {
    throw new Error('the web global setup did not export DILLA_TEST_HOST, DILLA_TESTKIT_INVITE and DILLA_TESTKIT_CONTROL');
  }
  const check = process.env.DILLA_DEMO_CHECK === '1';
  const driver = await WebDriver.start(host, { DILLA_TESTKIT_INVITE: invite, DILLA_TESTKIT_CONTROL: control });
  try {
    const setup = await driver.request<DemoSetup>('setup', { community: 'demo', channel: 'general' });
    await driver.request('register', {});
    if (check) await driver.request('sync', {});
    console.log(`dilla demo: open ${host}/welcome?invite=${setup.invite_code}`);
    console.log(`dilla demo: the peer ${setup.username} answers in #general; Ctrl-C stops`);
    if (check) {
      expect(typeof setup.invite_code === 'string' && setup.invite_code.length > 0).toBe(true);
      return;
    }
    // Until interrupted: Playwright then runs the global teardown, which stops the host.
    for (;;) {
      const { received } = await driver.request<{ received: DemoMessage[] }>('sync', {});
      for (const m of received) {
        // Never answer the peer's own messages, should a sync ever return one: the echo would loop.
        if (m.sender_device === setup.device_id) continue;
        await driver.request('send', { body: echoOf(m.body) });
      }
      await new Promise((done) => setTimeout(done, POLL_MS));
    }
  } finally {
    await driver.close();
  }
});
