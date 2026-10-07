# Flow 03 — signing in on another browser, and removing a device (web-2a)

The strings, the refusal table and the flow rules of this document began as L-COPY-02 of the web-2a plan, quoted. Since the web-2a whole-branch review (2026-10-07) this document's Copy table is the record of these strings and rules, held equal to `en.ts` by `copy.test`; L-COPY-02 carries a record note that points here. A change is made here and in `en.ts` together.

How a person who already has an account adds a second browser to it, and how a device leaves the
account again. Wireframed before it is built (F16). Built by web-2a task 16 (`RecoveryKeyField`,
`SettingsFrame`, `SettingsNav`, `DeviceRow` in `@dilla/ui`), task 18 (the screen
`packages/web/src/screens/SignIn.tsx`, the entry on onboarding step 1, and the strings in
`packages/web/src/strings/en.ts`) and task 19 (Settings → Devices and its four dialogs). The sign-up
ceremony is `01-onboarding.md`; the recovery key it shows is `02-recovery-key.md`.

Every user-visible string is a key of `packages/web/src/strings/en.ts`; the "Copy" table at the end is
the exact English text. `{instance}` is `AccountState.instance.name` (for example `dilla.thim.dev`),
`{username}` the username the person typed in step 1 as the server stored it, `{n}` a number,
`{seconds}` a whole number, `{code}` an error code such as `E_CORE_STATE`, `{when}` a time
from `formatTime` (today) or a date from `formatDay` (earlier).

The wireframes write each string as the Copy table has it. On screen the field labels, the step line,
the settings title and the device tags are drawn in capitals by CSS; the text itself, and what a screen
reader reads, stays as written. A row name in Settings → Devices is the first eight hexadecimal
characters of the device id: devices have no names in this version.

## Entry

| `account.phase` | the page shows |
|---|---|
| `needs-signup`, `instance.passwordSignup` true | onboarding step 1 (`01-onboarding.md`) with the ghost button `onboarding.connect.signIn` under the invite field |
| `needs-signup`, `instance.passwordSignup` false | onboarding step 1 without that button: this version signs in with a password only |
| `signin-login` | step 1, recovery key, until the person continued with a key of 52 characters; then step 2, login |
| `signin-totp` | step 3, second factor |
| `signin-key` | step 1, recovery key, for an enrolment already registered (a wrong key, a reload in the middle of the ceremony, see "Reload and interruption") |
| `enrolling` | the step whose button started it, in its working state |
| `ready`, reached by `signInKey` in this page | step 4, done |
| `ready` on a fresh load | not this flow: the shell |
| `cleared` | the boot splash, then a reload: to `/welcome?signin=race` after `E_LIST_RACE` (onboarding step 1 with the warn banner `signin.error.listRace`), to `/welcome?signin=evicted` after `E_SIGNIN_EVICTED` (onboarding step 1 with the danger banner `signin.error.evicted`), else to `/` |
| any other phase | not this flow: the boot screen |

`instance.passwordSignup` is `authMethods.includes(0)` (`packages/client-core/src/worker/controller.ts:260`),
so the button is offered exactly when the instance takes password logins.
On a closed instance (registration mode 2) the closed frame of `01-onboarding.md` has no step 1, so the
button stands under the closed frame's paragraph instead (see "States"): a closed instance still has
accounts that want a second browser.

Worker commands. `Use an existing account` sends `signInBegin` (phase `signin-login`). The recovery key
comes first, before the host login (the coordinator's ruling on REGISTRATION-DEVICES-02's concern 3): step 1
asks for it, and its `Continue` sends nothing; the page holds the key in its own memory once its count is 52
and shows step 2. Step 2's `Continue` sends `signInLogin` with the username, the password and the key. The
worker has the core check the key's form first (the core's normaliser and its strict 52-character parse); a
key of the wrong form is refused before the login is sent, and the page shows step 1 again with the field
error and the text kept. Then the worker logs in. When a second factor is owed the phase is `signin-totp`
and the worker keeps no key; step 3's `Continue` sends `signInTotp` with the code and the key again. Once
the login (and the code) passed, back to back and inside the same command, the worker registers this
browser as a pending device of the account, fetches the recovery data, lets the core open it with the key
and sign the next device list, and publishes that list: the instance's login assertion is spent seconds
after it was minted, and the new device is outside the list for a few round trips only. The phase is
`enrolling` while that runs and `ready` when this browser is a listed device. When the core refuses the key
after the registration (a well-formed key of another account) or the page reloads mid-enrolment, the phase
is `signin-key`: step 1 again, whose forward button `Add this browser` sends `signInKey` with the key and
runs the fetch, the enrolment and the `PUT` without registering again. `Create a new account instead` on
step 1 before the login, and `Cancel` on steps 2 and 3 and on step 1 of a registered enrolment, send
`signInCancel` and the page shows onboarding step 1. The step shown follows `account.phase` and the key the
page holds, never the command the page sent: a refusal of the login, of the second factor or of the
registration leaves the phase at `signin-login` or returns it there, so the page shows step 2 (the key
still held) with its banner or field error and the person signs in again; a failed fetch of the recovery
data stops at step 1. The password and the code leave the page once each, inside their one command; the key
leaves it inside the command that registers (the login, or the code when a second factor is owed, so it
crosses twice for such an account, each time inside one command); none is ever stored by the page.

## Steps

| n | name | heading (`<h1>`) | parts |
|---|---|---|---|
| 1 | recovery key | `signin.key.title` | one paragraph, `RecoveryKeyField`, ghost `Button` `signin.login.createInstead` and `Button` Continue (`signin.login.submit`); for a registered enrolment `Button` Cancel and `signin.key.submit` |
| 2 | login | `signin.login.title` | `OnboardingFrame`, one paragraph, `TextField` username and password, `Button` Cancel and Continue |
| 3 | second factor | `signin.totp.title` | one paragraph, `TextField` code, `Button` Cancel and Continue |
| 4 | done | `signin.done.title` | one paragraph, `Button` `signin.done.next` |

Four steps, each one `OnboardingFrame` whose step line is `signin.step`. The second-factor step is counted
even when it is skipped, so the numbers never change: an account without a second factor goes 1 → 2 → 4.
Each of the first three is one `<form noValidate>`: `Enter` in a field submits the step, as does its
forward button (`type="submit"`). The back button comes first in the footer, is `type="button"` and never
submits: `Create a new account instead` (a ghost button) on step 1 before the login, which has no `Cancel`,
and `Cancel` on steps 2 and 3 and on step 1 of a registered enrolment. A submit with an empty `Username`,
`Password` or `Code` sends nothing (see "Empty fields" under "States"). Step 4's only button is `Open dilla`,
which navigates to `/`, replacing the history entry. The working status line `signin.key.working`
(`role="status"`) stands on steps 1, 2 and 3 and is filled while the enrolment runs.

Fields: username `autoComplete="username"`, `spellCheck={false}`; password `type="password"`,
`autoComplete="current-password"`; code `inputMode="numeric"`, `autoComplete="one-time-code"`; the
recovery key `RecoveryKeyField` (monospace, `autoComplete="off"`, `autoCapitalize="characters"`,
`spellCheck={false}`, no `maxLength`, paste allowed, F2 and WCAG 3.3.8).

## Wireframes at 1280 × 800

The frame is `OnboardingFrame`, as in `01-onboarding.md`: the top bar with the brand mark and a centred
column of at most 40rem.

Onboarding step 2 with the entry (the rest of onboarding is unchanged):

```
+----------------------------------------------------------------------------------------------+
| [D] DILLA_                                                                                   |
+----------------------------------------------------------------------------------------------+
|                                                                                              |
|                      Join dilla.thim.dev                                  <h1>, has focus    |
|                      Step 1 of 5                                                             |
|                                                                                              |
|                      You need an invite from someone on dilla.thim.dev. Paste it below.      |
|                                                                                              |
|                      Invite                                                                  |
|                      +--------------------------------------------------+                    |
|                      | k7qm3zrdw0pahv5cj8zem4tbs6                       |                    |
|                      +--------------------------------------------------+                    |
|                      A code or a link, as you received it.                                   |
|                      [ Use an existing account ]                          (ghost button)     |
|                      --------------------------------------------------                      |
|                                                            [ Continue ]                      |
+----------------------------------------------------------------------------------------------+
```

Step 2, login:

```
+----------------------------------------------------------------------------------------------+
| [D] DILLA_                                                                                   |
+----------------------------------------------------------------------------------------------+
|                                                                                              |
|                      Sign in to dilla.thim.dev                            <h1>, has focus    |
|                      Step 2 of 4                                                             |
|                                                                                              |
|                      Use the username and password of your account on dilla.thim.dev.        |
|                                                                                              |
|                      Username                                                                |
|                      +--------------------------------------------------+                    |
|                      | ada                                              |                    |
|                      +--------------------------------------------------+                    |
|                      Password                                                                |
|                      +--------------------------------------------------+                    |
|                      | ••••••••••                                       |                    |
|                      +--------------------------------------------------+                    |
|                      --------------------------------------------------                      |
|                                           [ Cancel ]    [ Continue ]                         |
|                         (ghost button)                                                       |
+----------------------------------------------------------------------------------------------+
```

Step 3, second factor:

```
+----------------------------------------------------------------------------------------------+
| [D] DILLA_                                                                                   |
+----------------------------------------------------------------------------------------------+
|                                                                                              |
|                      Your second factor                                   <h1>, has focus    |
|                      Step 3 of 4                                                             |
|                                                                                              |
|                      Enter the six-digit code from your authenticator app.                   |
|                                                                                              |
|                      Code                                                                    |
|                      +--------------------------------------------------+                    |
|                      | 482913                                           |                    |
|                      +--------------------------------------------------+                    |
|                      --------------------------------------------------                      |
|                                               [ Cancel ]    [ Continue ]                     |
+----------------------------------------------------------------------------------------------+
```

Step 1, recovery key. The field shows what was typed or pasted, as it was typed; the line under it
counts the characters that remain after spaces, tabs, line breaks and the three dash characters are
dropped (`normaliseRecoveryKey`, the same rule the core applies):

```
+----------------------------------------------------------------------------------------------+
| [D] DILLA_                                                                                   |
+----------------------------------------------------------------------------------------------+
|                                                                                              |
|                      Your recovery key                                    <h1>, has focus    |
|                      Step 1 of 4                                                             |
|                                                                                              |
|                      Type or paste the recovery key you wrote down when the account was      |
|                      created. Spaces and hyphens do not matter.                              |
|                                                                                              |
|                      Recovery key                                                            |
|                      +--------------------------------------------------+                    |
|                      | 7K3M QW9D X2RT 0PNA HV5C J8ZE M4TB S6YF 1GKD R3WP| (scrolls)          |
|                      +--------------------------------------------------+                    |
|                      52 of 52 characters                                  (its description)  |
|                      --------------------------------------------------                      |
|                           [ Create a new account instead ]  [ Continue ]                     |
+----------------------------------------------------------------------------------------------+
```

Until the count is 52, the forward button (`Continue` before the login, `Add this browser` on a registered
enrolment) is blocked (`aria-disabled="true"`, never the native `disabled`) and the line
`signin.error.keyLength` stands under it as its description:

```
|                      Recovery key                                                            |
|                      +--------------------------------------------------+                    |
|                      | 7K3M QW9D X2RT                                   |                    |
|                      +--------------------------------------------------+                    |
|                      12 of 52 characters                                  (its description)  |
|                      --------------------------------------------------                      |
|                           [ Create a new account instead ]  [ Continue ]                     |
|                                                      aria-disabled                           |
|                                                      A recovery key has 52 characters.       |
```

Step 4, done:

```
+----------------------------------------------------------------------------------------------+
| [D] DILLA_                                                                                   |
+----------------------------------------------------------------------------------------------+
|                                                                                              |
|                      You’re in                                            <h1>, has focus    |
|                      Step 4 of 4                                                             |
|                                                                                              |
|                      This browser is now a device of ada on dilla.thim.dev. Messages sent    |
|                      before now are not shown here.                                          |
|                      --------------------------------------------------                      |
|                                                          [ Open dilla ]                      |
+----------------------------------------------------------------------------------------------+
```

## Wireframes at 360 × 740

The column takes the full width less 1.5rem on each side; nothing scrolls sideways (WCAG 1.4.10). The
footer buttons wrap to a second line when they do not fit, the forward button last. The recovery key
field keeps one line and scrolls inside itself.

```
+--------------------------------------+   +--------------------------------------+
| [D] DILLA_                           |   | [D] DILLA_                           |
+--------------------------------------+   +--------------------------------------+
|  Sign in to dilla.thim.dev           |   |  Your second factor                  |
|  Step 2 of 4                         |   |  Step 3 of 4                         |
|  Use the username and password of    |   |  Enter the six-digit code from your  |
|  your account on dilla.thim.dev.     |   |  authenticator app.                  |
|  Username                            |   |  Code                                |
|  +--------------------------------+  |   |  +--------------------------------+  |
|  | ada                            |  |   |  | 482913                         |  |
|  +--------------------------------+  |   |  +--------------------------------+  |
|  Password                            |   |  ------------------------------      |
|  +--------------------------------+  |   |        [ Cancel ]  [ Continue ]      |
|  | ••••••••••                     |  |   +--------------------------------------+
|  +--------------------------------+  |
|  ------------------------------      |
|  [ Cancel ]                          |
|                     [ Continue ]     |
+--------------------------------------+

+--------------------------------------+   +--------------------------------------+
| [D] DILLA_                           |   | [D] DILLA_                           |
+--------------------------------------+   +--------------------------------------+
|  Your recovery key                   |   |  You’re in                           |
|  Step 1 of 4                         |   |  Step 4 of 4                         |
|  Type or paste the recovery key you  |   |  This browser is now a device of ada |
|  wrote down when the account was     |   |  on dilla.thim.dev. Messages sent    |
|  created. Spaces and hyphens do not  |   |  before now are not shown here.      |
|  matter.                             |   |  ------------------------------      |
|  Recovery key                        |   |                    [ Open dilla ]    |
|  +--------------------------------+  |   +--------------------------------------+
|  | 7K3M QW9D X2RT 0PNA HV5C J8ZE M|  |
|  +--------------------------------+  |
|  52 of 52 characters                 |
|  ------------------------------      |
|  [ Create a new account instead ]    |
|            [ Continue ]              |
+--------------------------------------+
```

## States

Working. While `signInLogin` or `signInTotp` runs, the forward button reads `signin.login.working` and
both footer buttons are blocked (`aria-disabled="true"`, so they stay focusable and focus stays on the
pressed button); once the enrolment runs inside it (phase `enrolling`), the step's status line
`signin.key.working` (`role="status"`) fills. While `signInKey` runs on a registered enrolment, both
buttons of step 1 are blocked, the forward button keeps its label, and the same status line stands above
the footer:

```
|                      52 of 52 characters                                                     |
|                      Adding this browser to your account…                 (role="status")    |
|                      --------------------------------------------------                      |
|                                        [ Cancel ]    [ Add this browser ]                    |
|                                        aria-disabled aria-disabled                           |
```

Second factor skipped: when the account has no confirmed second factor, step 2 is followed by step 4,
whose step line reads `Step 4 of 4`.

Empty fields: a submit of step 2 or 3 with an empty `Username`, `Password` or `Code` sends nothing; every
empty field shows the field error `signin.error.required` (`role="alert"`) and focus moves to the first
of them. Typing in a field clears its error:

```
|                      Username                                                                |
|                      +--------------------------------------------------+                    |
|                      | ada                                              |                    |
|                      +--------------------------------------------------+                    |
|                      Password                                                                |
|                      +--------------------------------------------------+  (danger border)   |
|                      |                                                  |  has focus         |
|                      +--------------------------------------------------+                    |
|                      ✕ Fill in this field.                               role="alert"        |
```

Wrong username or password: the password field is emptied and shows the field error; focus moves to it:

```
|                      Password                                                                |
|                      +--------------------------------------------------+  (danger border)   |
|                      |                                                  |                    |
|                      +--------------------------------------------------+                    |
|                      ✕ That username and password did not work.          role="alert"        |
```

Wrong code (`E_UNAUTHENTICATED` or `E_NO_ASSERTION` from `signInTotp`): the instance spent the login when
it checked the code, so the code step cannot succeed again (ruling 39). The worker returns the phase to
`signin-login` and the page shows step 2: the username keeps its text, the password field is empty and
takes focus (after the frame focused the new step's heading), and the warn banner
`signin.error.totpFailed` stands first in the step's body:

```
|                      Sign in to dilla.thim.dev                                               |
|                      Step 2 of 4                                                             |
|                      +------------------------------------------------------------------+    |
|                      | ▲ That code did not work. Sign in again with a fresh code.       |    |
|                      +------------------------------------------------------------------+    |
|                      Use the username and password of your account on dilla.thim.dev.        |
|                                                                                              |
|                      Username                                                                |
|                      +--------------------------------------------------+                    |
|                      | ada                                              |                    |
|                      +--------------------------------------------------+                    |
|                      Password                                                                |
|                      +--------------------------------------------------+                    |
|                      |                                                  |  has focus         |
|                      +--------------------------------------------------+                    |
```

Wrong recovery key: the field keeps what was typed and shows `signin.error.wrongKey`; focus moves to the
field, so the person can correct one character:

```
|                      Recovery key                                                            |
|                      +--------------------------------------------------+  (danger border)   |
|                      | 7K3M QW9D X2RT 0PNA HV5C J8ZE M4TB S6YF 1GKD R3WP|                    |
|                      +--------------------------------------------------+                    |
|                      52 of 52 characters                                                     |
|                      ✕ This is not the recovery key of this account. Check every character.  |
```

No recovery data (`E_NO_BACKUP` on a reload into step 1, whose fetch finds no recovery data): step 1
shows the danger banner `signin.error.noBackup` and neither the field nor `Add this browser`; `Cancel`
is the only way on:

```
|                      Your recovery key                                    <h1>, has focus    |
|                      Step 1 of 4                                                             |
|                      +------------------------------------------------------------------+    |
|                      | ✕ This account has no recovery data on dilla.thim.dev. It was    |    |
|                      |   created before recovery existed, and its browser has not been  |    |
|                      |   online since. Open it there first.                             |    |
|                      +------------------------------------------------------------------+    |
|                      --------------------------------------------------                      |
|                                                            [ Cancel ]                        |
```

No usable backup state (`E_NO_BACKUP` from `signInKey`: the fetch found no recovery data, or the
account's recovery data is there but the part that carries its device state is missing or cannot be
read): the same view, with the danger banner `signin.error.noBackupState` in place of
`signin.error.noBackup`:

```
|                      +------------------------------------------------------------------+    |
|                      | ✕ This account has no backup to recover from on dilla.thim.dev.  |    |
|                      |   Sign in on a device that still holds this account and open     |    |
|                      |   dilla there; it repairs the backup. Then try again.            |    |
|                      +------------------------------------------------------------------+    |
|                      --------------------------------------------------                      |
|                                                            [ Cancel ]                        |
```

Device cap (`E_FORBIDDEN` 403 from the registration inside `signInLogin` or `signInTotp`): the instance refuses a new
browser only when every device it counts for the account is in the account's device list (a device that
signed in but never joined the list is replaced instead). The worker returns the phase to `signin-login`,
so the refusal is shown on step 2, with the username and the held key kept; `Continue` signs in again once
a device was removed. The banner is the first child of step 2's body, under the step line; the buttons are
enabled again. From step 2 focus stays on the pressed button and the banner announces itself
(`role="alert"`); from step 3 the step changes and focus moves to step 2's heading. The device-cap banner
(danger), on step 2:

```
|                      Sign in to dilla.thim.dev                                               |
|                      Step 2 of 4                                                             |
|                      +------------------------------------------------------------------+    |
|                      | ✕ This account already has as many devices as dilla.thim.dev     |    |
|                      |   allows. Remove one in Settings on another device first.        |    |
|                      +------------------------------------------------------------------+    |
|                      Use the username and password of your account on dilla.thim.dev.        |
```

Too many attempts (`E_RATE_LIMITED` 429 from `signInLogin` or `signInTotp`: the login, the second-factor
route or the registration): the instance limits logins from one network, and registration attempts from one network or
one device, and answers with a wait. The
page cannot tell these limits apart and does not need to: every one is a short wait, shown by one warn
banner, `signin.error.tooMany`, on step 2 (the worker leaves or returns the phase at `signin-login`), with
the username kept and the same focus rules as the device cap:

```
|                      Sign in to dilla.thim.dev                                               |
|                      Step 2 of 4                                                             |
|                      +------------------------------------------------------------------+    |
|                      | ▲ Too many sign-in attempts. Try again in 40 s.                  |    |
|                      +------------------------------------------------------------------+    |
|                      Use the username and password of your account on dilla.thim.dev.        |
```

Network failure and other refusals: a `Banner` is the first child of the body of the step `account.phase`
names after the refusal, under the step line; the buttons are enabled again. When the step does not
change, focus stays where it was and the banner announces itself (`role="alert"`); when a refusal of step 3
returns the phase to `signin-login`, focus moves to step 2's heading.

Someone else is signing in (`E_SIGNIN_EVICTED`, from the enrolment inside `signInLogin`, `signInTotp` or
`signInKey`): another sign-in to the account, with
its password, replaced this browser's row at the instance before the new device list named it (a 401 on
the fetch, on the list `PUT` or on the session after it). Before the core wrote the enrolment, the worker
drops it and returns the phase to `signin-login`: step 2 shows the danger banner `signin.error.evicted`. After the core wrote it, the worker clears this browser's data as for `E_LIST_RACE`
and the page reloads to `/welcome?signin=evicted`, where onboarding step 1 shows the same banner. Either
way the page never shows the revoked splash for it:

```
|                      Sign in to dilla.thim.dev                            <h1>, has focus    |
|                      Step 2 of 4                                                             |
|                      +------------------------------------------------------------------+    |
|                      | ✕ Someone else is signing in to this account. Change your        |    |
|                      |   password from a device you still have, or ask the operator.    |    |
|                      +------------------------------------------------------------------+    |
|                      Use the username and password of your account on dilla.thim.dev.        |
```

The devices changed while signing in (`E_LIST_RACE`, from `signInKey`): another device published a new
device list between the login and the key. The worker clears this browser's data and the phase becomes
`cleared`; the page shows the boot splash and reloads to `/welcome?signin=race`, so the person sees
onboarding step 1 (the connect step), its heading focused, with the warn banner `signin.error.listRace`
first in its body. The enrolment record is gone with the data, so the person signs in again from the
start and enters the key after the next login. The query is dropped on the first navigation away from
the connect step:

```
|                      Join dilla.thim.dev                                  <h1>, has focus    |
|                      Step 1 of 5                                                             |
|                      +------------------------------------------------------------------+    |
|                      | ▲ The account’s devices changed while you were signing in. Sign  |    |
|                      |   in again.                                                      |    |
|                      +------------------------------------------------------------------+    |
|                      You need an invite from someone on dilla.thim.dev. Paste it below.      |
|                      ...                                                                     |
|                      [ Use an existing account ]                          (ghost button)     |
```

Closed instance (`instance.registrationMode` 2, `instance.passwordSignup` true): the closed frame of
`01-onboarding.md` gains the entry, so an existing account can still add a browser:

```
|                      dilla.thim.dev is not taking new accounts            <h1>, has focus    |
|                      Ask the host of dilla.thim.dev when sign-ups open again.                |
|                      [ Use an existing account ]                          (ghost button)     |
```

Refusals of the sign-in commands, switched on `code` and `status` only (never on `detail`), each
clearing the working state. The step shown is the one `account.phase` names after the refusal: step 2
after a refused login, second factor or registration (`signInLogin`, `signInTotp`, the registration
inside `signInLogin` or `signInTotp`), step 1 after a key the core refused, a refused fetch of the recovery
data or a refused enrolment:

| `code` | `status` | from | goes to | shown |
|---|---|---|---|---|
| `E_UNAUTHENTICATED` | 401 | `signInLogin` | step 2, password emptied, focus on the password field | field error `signin.error.loginFailed` |
| `E_UNAUTHENTICATED` | 401 | `signInTotp` | step 2 (phase `signin-login`), username kept, password empty, focus on the password field | warn banner `signin.error.totpFailed` |
| `E_NO_ASSERTION` | 0 | `signInTotp` | step 2 (phase `signin-login`), username kept, password empty, focus on the password field | warn banner `signin.error.totpFailed` |
| `E_FORBIDDEN` | 403 | `signInLogin`, `signInTotp` (the registration) | step 2 (phase `signin-login`), username kept | danger banner `signin.error.deviceCap` |
| `E_RATE_LIMITED` | 429 | `signInLogin`, `signInTotp` (the login, the second-factor route or the registration) | step 2 (phase `signin-login`), username kept | warn banner `signin.error.tooMany` with `seconds = Math.ceil(retryAfterMs / 1000)`; `onboarding.error.rateLimitedNoWait` (flow 01) when `retryAfterMs` is `null` |
| `E_NO_BACKUP` | 0 | the reload into step 1 (the fetch) | step 1 without the field | danger banner `signin.error.noBackup`; `Cancel` only |
| `E_NO_BACKUP` | 0 | `signInLogin`, `signInTotp`, `signInKey` (the fetch or the backup state) | step 1 without the field | danger banner `signin.error.noBackupState`; `Cancel` only |
| `E_RECOVERY_KEY` | 0 | `signInLogin`, `signInTotp`, `signInKey` (the key's form, before the login is sent, or the root object after the registration) | step 1, value kept, focus on the field | field error `signin.error.wrongKey` |
| `E_SIGNIN_EVICTED` | 0 | `signInLogin`, `signInTotp`, `signInKey` (a 401 on the fetch, the list `PUT` or the session after it) | step 2 (phase `signin-login`), or after a written enrolment phase `cleared` and the reload to `/welcome?signin=evicted`, onboarding step 1 | danger banner `signin.error.evicted` |
| `E_LIST_RACE` | 0 | `signInKey` | phase `cleared`: the boot splash, then the reload to `/welcome?signin=race`, onboarding step 1 | warn banner `signin.error.listRace` on the connect step |
| `E_NETWORK`, or any code with `status` ≥ 500 | — | any | the step `account.phase` names | danger banner `signin.error.network` |
| anything else | below 500 | any | the step `account.phase` names | danger banner `signin.error.other` with `{code}` |

A `401` from the registration inside `signInKey` (a login older than the instance's five-minute
assertion, an account that never published a device list, or a fault of the instance) returns the phase to
`signin-login` and shows `signin.error.other` with its code on step 2; the person signs in again.

## Focus and announcements

| event | focus | announced |
|---|---|---|
| a step appears (forward, back to step 1 or 2, the done step) | that step's `<h1>` (`OnboardingFrame` focuses its heading whenever the title changes) | the heading, by the focus move |
| a field error after a refusal, or `signin.error.required` on a submit | that field (the first empty one for `signin.error.required`) | the error, by its `role="alert"` paragraph; the field's description is hint then error |
| a refused second factor (step 3 → step 2) | step 2's `<h1>`, then the empty password field | the banner `signin.error.totpFailed` (`role="alert"`), then the field |
| a banner on the step that is shown | unchanged | the banner (`role="alert"`) |
| a banner on a step the refusal returns to (any other refusal of step 3: the device cap, too many attempts, the network) | step 2's `<h1>` | the heading, then the banner |
| the reload after `E_LIST_RACE` | onboarding step 1's `<h1>` | the heading, then the banner `signin.error.listRace` |
| `E_SIGNIN_EVICTED` (back to step 2, or the reload) | step 2's `<h1>`, or onboarding step 1's `<h1>` after the reload | the heading, then the banner `signin.error.evicted` |
| a command starts | unchanged (the pressed button becomes `aria-disabled` and keeps focus) | the button's new label is not announced; once the enrolment runs, `signin.key.working` in the step's status line (`role="status"`) |
| the key count changes | unchanged | nothing: the count `signin.key.hint` is the field's description, read when the field takes focus; it is not a live region, so typing is not interrupted |
| the count reaches 52 | unchanged | `Add this browser` loses the description `signin.error.keyLength` |

Tab order inside each step: the fields in visual order, then the footer: on step 1 before the login
`Create a new account instead`, then `Continue`; on steps 2 and 3, and on step 1 of a registered enrolment,
`Cancel`, then the forward button. On onboarding step 1: the
invite field, `Use an existing account`, `Continue`. On the closed frame: `Use an existing account`.
There are no single-key shortcuts.

## Error placement

| check | where | key |
|---|---|---|
| an empty `Username`, `Password` or `Code` on submit | under each empty field, as its field error; nothing is sent | `signin.error.required` |
| a key that does not normalise to 52 characters | under `Add this browser`, as its description while it is blocked; on a submit, also as the field's error, focus on the field, nothing sent | `signin.error.keyLength` |
| a refusal of a sign-in command | as the refusal table under "States" says | — |

The page checks nothing else before sending: a username or password that is not empty is sent as typed
and judged by the instance, which answers the same way for every wrong pair.

## Reload and interruption

- Reload on step 1, 2 or 3 before the enrolment started: the worker holds no device record (the
  registration runs only inside the command that carries the key) and the page holds the key only in its
  memory, which the reload clears; the page opens at onboarding step 1. The assertion, if one was issued,
  is forgotten and expires at the instance.
- Reload while the enrolment runs before the instance accepted the new device list, or after a wrong
  key: the store holds the enrolment record with the account's user id; the worker fetches the
  recovery data again and the page opens at step 1 with an empty field (L-TS-23: boot in phase 3 with a
  user id). The next `Add this browser` does not register again.
- Reload while registering, before the instance named the account's user: the worker clears the
  enrolment record and the page opens at onboarding step 1.
- Reload after the instance accepted the new device list: this browser is a device of the account and
  the shell opens directly; step 4 is not shown.

## Settings → Devices, and the revoke and sign-out ceremonies

Settings is a modal `<dialog>` over the shell (`SettingsFrame`), reached at `/settings/devices` from the
rail's last button (`shell.rail.settings`). Its `<h1>` is `settings.title` and takes focus when the frame
opens; its navigation (`settings.nav.label`) is one tab stop over three buttons with roving focus
(`ArrowUp`/`ArrowDown`, `Home`/`End`), the current one `aria-current="page"`; the close button is
`settings.close`; `Escape` closes the frame and returns to the route the person came from and to the
rail's settings button. `Escape` inside one of the dialogs below closes only that dialog. On opening the
Devices section the page sends `refreshDevices`.

At 1280 the frame is 960 × 640 with a 220px navigation (brief "Layout"):

```
+----------------------------------------------------------------------------------------------+
| SETTINGS             | Devices                                       [ Close settings  esc ] |
| -------------------  | --------------------------------------------------------------------  |
| > devices            | Every browser and app signed in to your account. Removing a device    |
|   notifications      | needs your recovery key.                                              |
|   appearance         |                                                                       |
|                      | 3f9a2c1d  [browser] [this browser]                                    |
|                      |   last seen 21:04                                                     |
|                      | b2d4e6f8  [app]                                       [ remove ]      |
|                      |   last seen 21:02                                                     |
|                      | 0a1b2c3d  [browser]                                   [ remove ]      |
|                      |   not yet in the device list · last seen 20:40                        |
|                      | 99ee0f11  [browser]                                                   |
|                      |   removed · last seen 1 Oct 2026                                      |
|                      |                                                                       |
|                      | 3 devices                                            [ refresh ]      |
|                      | --------------------------------------------------------------------  |
|                      | [ sign out and remove this browser ]    [ forget this browser ]       |
+----------------------------------------------------------------------------------------------+
```

At 360 the frame fills the viewport and the navigation stacks above the section:

```
+--------------------------------------+
| SETTINGS          [ Close settings ] |
| > devices                            |
|   notifications                      |
|   appearance                         |
| --------------------------------     |
| Devices                              |
| Every browser and app signed in to   |
| your account. Removing a device      |
| needs your recovery key.             |
| 3f9a2c1d [browser] [this browser]    |
|   last seen 21:04                    |
| b2d4e6f8 [app]                       |
|   last seen 21:02                    |
|                        [ remove ]    |
| 3 devices             [ refresh ]    |
| [ sign out and remove this           |
|   browser ]                          |
| [ forget this browser ]              |
+--------------------------------------+
```

A recovery root this account did not seal (BACKUPS-RECOVERY-04): when the worker finds that the instance
holds a root object other than the one this account sealed (`E_ROOT_MISMATCH`, `account.rootMismatch`), the
danger banner `devices.rootMismatch` stands first in the Devices section, under its heading, and in the
shell's banner area above the conversation, with no dismiss button, for as long as the slice reports it:
the recovery key cannot open that object, so removing a device or adding a browser with the key would fail.

Rows. Each device is a `DeviceRow`: the name (first eight hexadecimal characters of the device id), the
tier tag (`devices.tier.web` for a browser, `devices.tier.native` for an app), the tag
`devices.thisBrowser` on this browser's row, a state (`devices.unlisted` when the device is not in the
account's newest device list, `devices.revoked` when it was removed, nothing otherwise) and
`devices.lastSeen`. Rows are ordered: this browser first, then the others by last seen, newest first,
removed devices last. `devices.revoke` is offered on every other device that is not removed: on a listed
device it opens the remove dialog with the recovery key; on a device that is not yet in the device list
it opens the remove-unlisted dialog without a key (ruling 30: no signed list names such a device, so
removing it changes no list). This browser's row and removed rows offer nothing. Under the list stand
the count line and `devices.refresh`; under a hairline, `devices.signOut` and `devices.forget`. The count
line is `devices.cap.other` (`{n} devices`), or `devices.cap.one` (`one device`) when the count is 1; it
counts the devices that are not removed, this browser included, and the instance's cap is not shown
(ruling 33).

Remove another listed device (`devices.revoke` on a listed row) opens a `Dialog` titled
`devices.revokeTitle`:

```
+--------------------------------------------------------------+
| Remove this device?                                          |
| (<h2>; the dialog has focus)                                 |
|                                                              |
| The device is signed out everywhere and leaves every         |
| conversation. Enter your recovery key to confirm.            |
|                                                              |
| Recovery key                                                 |
| +----------------------------------------------------+       |
| |                                                    |       |
| +----------------------------------------------------+       |
| 0 of 52 characters                                           |
|                                                              |
|                       [ Close  esc ]  [ Remove ] (danger)    |
+--------------------------------------------------------------+
```

Remove a device that is not in the device list (`devices.revoke` on a row whose state is
`devices.unlisted`) opens a `Dialog` titled `devices.removeUnlistedTitle`, without a key field:

```
+--------------------------------------------------------------+
| Remove this device?                                          |
| (<h2>; the dialog has focus)                                 |
|                                                              |
| This device signed in with your password but is not in the   |
| device list, so it cannot read anything. Removing it needs   |
| no recovery key.                                             |
|                                                              |
|                       [ Close  esc ]  [ Remove ] (danger)    |
+--------------------------------------------------------------+
```

Sign out and remove this browser (`devices.signOut`) opens a `Dialog` titled `devices.signOutTitle`:

```
+--------------------------------------------------------------+
| Sign out and remove this browser?                            |
| (<h2>; the dialog has focus)                                 |
|                                                              |
| This browser is removed from your account and its data here  |
| is cleared. You can sign in again later with your password   |
| and recovery key. Enter the key to confirm.                  |
|                                                              |
| Recovery key                                                 |
| +----------------------------------------------------+       |
| |                                                    |       |
| +----------------------------------------------------+       |
| 0 of 52 characters                                           |
|                                                              |
|                     [ Close  esc ]  [ Sign out ] (danger)    |
+--------------------------------------------------------------+
```

Forget this browser (`devices.forget`) opens a `Dialog` titled `devices.forgetTitle`, without a key field:

```
+--------------------------------------------------------------+
| Forget this browser?                                         |
| (<h2>; the dialog has focus)                                 |
|                                                              |
| This clears dilla’s data from this browser and signs it out. |
| The device stays in your account’s device list until you     |
| remove it from another device.                               |
|                                                              |
|                       [ Close  esc ]  [ Forget ] (danger)    |
+--------------------------------------------------------------+
```

Every dialog's close button, first in its footer, is the `Close` button every dialog of the web client
has (web-1's `dialog.close`, with the key hint `esc`).

The two key dialogs. The body is one `<form noValidate>`; the field is `RecoveryKeyField` labelled
`devices.keyLabel` with the hint `signin.key.hint`; the confirm button is the form's
`type="submit"` danger button and is blocked (`aria-disabled="true"`, description `signin.error.keyLength`)
until the count is 52; a submit before then sends nothing, shows `signin.error.keyLength` as the field's
error and moves focus to the field. On submit with 52 characters the confirm button reads
`devices.working` and both buttons are blocked; the page sends `revokeDevice` with `recoveryKey` the key
as typed (another listed device) or `signOutRevoke` with the key as typed (this browser).

The two dialogs without a field. Their confirm is a danger button (`devices.confirmRevoke` in the
remove-unlisted dialog, `devices.confirmForget` in the forget dialog); on press it reads `devices.working`
and both buttons are blocked. The remove-unlisted dialog sends `revokeDevice` with `recoveryKey: null`;
the forget dialog sends `forgetBrowser`.

| outcome | then |
|---|---|
| `revokeDevice` resolved (either remove dialog) | the dialog closes, the list is refreshed, the row shows `devices.revoked` and no action; focus moves to the section heading `devices.title` (`tabIndex=-1`), because the button that opened the dialog is gone |
| `signOutRevoke` resolved | this browser's data is cleared and the phase is `cleared`: the page shows the boot splash and reloads to `/`, where onboarding step 1 opens with its heading focused; Settings itself does not navigate |
| `forgetBrowser` resolved | the same as `signOutRevoke`; the device stays listed on the account, as the dialog said |
| `E_RECOVERY_KEY` | the dialog stays open, the field keeps its text and shows `devices.error.wrongKey`, focus moves to the field |
| anything else | the dialog stays open with the danger banner `settings.error.other` and `{code}` as the first child of its body; focus stays on the confirm button |

Escape, the close button and a click on the backdrop close a dialog without sending anything, except
while a command runs, when they do nothing. Focus then returns to the button that opened the dialog.

## What is not offered, and why

| not offered | why |
|---|---|
| signing in with a passkey or a single sign-on provider | this version offers password (+ second factor) only (Q03); the entry is hidden on instances without password logins |
| messages from before this browser joined | a browser-only account has no archive writer; `signin.done.body` and `onboarding.browser.oneBrowser` say so |
| a copy button for the recovery key, anywhere | `protocol/03-identity.md` "Recovery" (F2); paste into the key field is allowed |
| removing a listed device without the recovery key | a new device list must be signed with the account's signing key, which only the recovery key opens in a browser; a device that is not yet in the device list is removed without the key, because no list changes (ruling 30) |
| naming a device, or a "verified" mark | devices have no names in this version, and the browser's lower trust is stated by its tier tag (F9) |

## Copy

| key | text | where |
|---|---|---|
| `onboarding.connect.signIn` | `Use an existing account` | ghost button under the invite field, onboarding step 1, and under the closed frame's paragraph, when `instance.passwordSignup` |
| `onboarding.keys.loss` | `This key is the only way to get your account back or to add another browser. If every browser you use loses its data and you do not have the key, the account and its history are gone, and the host cannot bring them back.` | second paragraph, onboarding step 3 (changed for web-2a) |
| `onboarding.browser.oneBrowser` | `To use this account in another browser, sign in there with your password and this recovery key. Messages sent before that browser joins are not shown in it.` | third paragraph, onboarding step 4 (changed for web-2a) |
| `signin.step` | `Step {n} of 4` | step line, steps 1–4 |
| `signin.login.title` | `Sign in to {instance}` | step heading, step 2 |
| `signin.login.body` | `Use the username and password of your account on {instance}.` | paragraph, step 2 |
| `signin.login.username` | `Username` | field label, step 2 |
| `signin.login.password` | `Password` | field label, step 2 |
| `signin.login.submit` | `Continue` | button, forward on steps 1 (before the login), 2 and 3 |
| `signin.login.working` | `Checking…` | the forward button of steps 2 and 3 while their command runs |
| `signin.login.createInstead` | `Create a new account instead` | ghost button, first in the footer of step 1 before the login; sends `signInCancel` |
| `signin.totp.title` | `Your second factor` | step heading, step 3 |
| `signin.totp.body` | `Enter the six-digit code from your authenticator app.` | paragraph, step 3 |
| `signin.totp.code` | `Code` | field label, step 3 |
| `signin.key.title` | `Your recovery key` | step heading, step 1 |
| `signin.key.body` | `Type or paste the recovery key you wrote down when the account was created. Spaces and hyphens do not matter.` | paragraph, step 1 |
| `signin.key.label` | `Recovery key` | field label, step 1 |
| `signin.key.hint` | `{n} of 52 characters` | hint under the key field (its description, not live), step 1 and the two key dialogs |
| `signin.key.submit` | `Add this browser` | button, forward on step 1 of a registered enrolment (before the login, step 1's forward button is `signin.login.submit`) |
| `signin.key.working` | `Adding this browser to your account…` | status line, steps 1–3, while the enrolment runs |
| `signin.done.title` | `You’re in` | step heading, step 4 |
| `signin.done.body` | `This browser is now a device of {username} on {instance}. Messages sent before now are not shown here.` | paragraph, step 4 |
| `signin.done.next` | `Open dilla` | button, step 4 |
| `signin.cancel` | `Cancel` | button, first in the footer of steps 2 and 3 and of step 1 of a registered enrolment; sends `signInCancel` |
| `signin.error.loginFailed` | `That username and password did not work.` | field error, password, step 2 |
| `signin.error.totpFailed` | `That code did not work. Sign in again with a fresh code.` | warn banner, step 2, after a refused second factor |
| `signin.error.required` | `Fill in this field.` | field error under an empty `Username`, `Password` or `Code` on submit, steps 2 and 3 |
| `signin.error.noBackup` | `This account has no recovery data on {instance}. It was created before recovery existed, and its browser has not been online since. Open it there first.` | danger banner, step 1, without the field, after `E_NO_BACKUP` from the fetch of a reload into step 1 |
| `signin.error.noBackupState` | `This account has no backup to recover from on {instance}. Sign in on a device that still holds this account and open dilla there; it repairs the backup. Then try again.` | danger banner, step 1, without the field, after `E_NO_BACKUP` from `signInKey` |
| `signin.error.wrongKey` | `This is not the recovery key of this account. Check every character.` | field error, recovery key, step 1 |
| `signin.error.keyLength` | `A recovery key has 52 characters.` | description of the blocked forward button while the count is not 52, and the field's error on such a submit, step 1 and the two key dialogs |
| `signin.error.deviceCap` | `This account already has as many devices as {instance} allows. Remove one in Settings on another device first.` | danger banner, step 2, after `E_FORBIDDEN` from the registration |
| `signin.error.evicted` | `Someone else is signing in to this account. Change your password from a device you still have, or ask the operator.` | danger banner, step 2 or onboarding step 1 after the reload to `/welcome?signin=evicted`, after `E_SIGNIN_EVICTED` |
| `signin.error.tooMany` | `Too many sign-in attempts. Try again in {seconds} s.` | warn banner, step 2, after `E_RATE_LIMITED` from the login, the second-factor route or the registration |
| `signin.error.listRace` | `The account’s devices changed while you were signing in. Sign in again.` | warn banner, onboarding step 1 (the connect step) after the reload to `/welcome?signin=race` that follows `E_LIST_RACE` |
| `signin.error.network` | `The connection dropped. Check it and try again.` | danger banner, any step |
| `signin.error.other` | `Signing in did not work ({code}). Try again.` | danger banner, any step |
| `shell.rail.settings` | `settings` | the rail's last button, which opens Settings |
| `settings.title` | `Settings` | the settings frame's `<h1>` |
| `settings.close` | `Close settings` | the settings frame's close button |
| `settings.nav.label` | `settings sections` | accessible name of the settings navigation |
| `settings.nav.devices` | `devices` | navigation button |
| `settings.nav.notifications` | `notifications` | navigation button |
| `settings.nav.appearance` | `appearance` | navigation button |
| `devices.title` | `Devices` | section heading (`<h2>`, `tabIndex=-1`), Devices |
| `devices.body` | `Every browser and app signed in to your account. Removing a device needs your recovery key.` | paragraph under the heading, Devices |
| `devices.thisBrowser` | `this browser` | tag on this browser's row |
| `devices.tier.web` | `browser` | tier tag of a browser |
| `devices.tier.native` | `app` | tier tag of an app |
| `devices.lastSeen` | `last seen {when}` | second line of every row |
| `devices.unlisted` | `not yet in the device list` | state of a device the newest device list does not name |
| `devices.revoked` | `removed` | state of a removed device |
| `devices.cap.one` | `one device` | line under the list when one device is not removed |
| `devices.cap.other` | `{n} devices` | line under the list; `{n}` counts the devices that are not removed, when that is not 1 |
| `devices.keyLabel` | `Recovery key` | field label, the two key dialogs of Settings → Devices |
| `devices.refresh` | `refresh` | button under the list; sends `refreshDevices` |
| `devices.revoke` | `remove` | button on the row of every other device that is not removed |
| `devices.signOut` | `sign out and remove this browser` | button under the hairline |
| `devices.forget` | `forget this browser` | button under the hairline |
| `devices.revokeTitle` | `Remove this device?` | dialog title, remove another device |
| `devices.revokeBody` | `The device is signed out everywhere and leaves every conversation. Enter your recovery key to confirm.` | dialog body, remove another device |
| `devices.removeUnlistedTitle` | `Remove this device?` | dialog title, remove a device that is not in the device list |
| `devices.removeUnlistedBody` | `This device signed in with your password but is not in the device list, so it cannot read anything. Removing it needs no recovery key.` | dialog body, remove a device that is not in the device list |
| `devices.signOutTitle` | `Sign out and remove this browser?` | dialog title, sign out and remove this browser |
| `devices.signOutBody` | `This browser is removed from your account and its data here is cleared. You can sign in again later with your password and recovery key. Enter the key to confirm.` | dialog body, sign out and remove this browser |
| `devices.forgetTitle` | `Forget this browser?` | dialog title, forget this browser |
| `devices.forgetBody` | `This clears dilla’s data from this browser and signs it out. The device stays in your account’s device list until you remove it from another device.` | dialog body, forget this browser |
| `devices.confirmRevoke` | `Remove` | danger confirm, the remove dialog and the remove-unlisted dialog |
| `devices.confirmSignOut` | `Sign out` | danger submit, sign-out dialog |
| `devices.confirmForget` | `Forget` | danger button, forget dialog |
| `devices.working` | `Working…` | the confirm button of a dialog while its command runs |
| `devices.error.wrongKey` | `This is not the recovery key of this account.` | field error, recovery key, the two key dialogs |
| `devices.rootMismatch` | `The recovery data stored for this account on {instance} is not this account’s. The recovery key will not work until the operator resets it.` | danger banner, first in Settings → Devices and in the shell's banner area, while `account.rootMismatch` |
| `settings.error.other` | `That did not work ({code}). Try again.` | danger banner, first in a Settings → Devices dialog's body; the one string for every refused Settings write |
