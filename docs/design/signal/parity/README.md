# Prototype-vs-story parity

`shoot.mjs` opens the Signal prototype (`../prototype/Dilla Signal Prototype.dc.html`, from `file://`) and a built
Storybook story at the same viewport, and writes three PNGs per pair: the prototype, the story, and the two side by side
(prototype left, story right, 1px grey divider).

## Run it

```
npm run build-storybook -w @dilla/ui
npx http-server packages/ui/storybook-static -p 6006 --silent &
node docs/design/signal/parity/shoot.mjs <spec.json> <outDir> [--storybook http://127.0.0.1:6006]
```

Output goes to `<outDir>/<name>.prototype.png`, `<name>.story.png` and `<name>.pair.png`. Keep `<outDir>` outside the
repo. One line is printed per pair (`ok` or `FAIL`); the exit code is non-zero if any side fails to load.
`examples/shell.json` is a working spec (desktop shell and phone shell).

The tool's own tests: `node --test docs/design/signal/parity/shoot.test.mjs` (pure helpers; not part of the root
`npm test`, there is no pattern for design-tooling tests there).

## Write a spec

A spec is a JSON array of pairs:

```json
{
  "name": "channel-row-active",
  "viewport": { "width": 1280, "height": 800 },
  "prototype": {
    "props": { "startAt": "app" },
    "steps": [{ "click": "text=general" }, { "hover": ".row" }, { "press": "Escape" }, { "type": ["input", "hi"] }, { "wait": 300 }],
    "clip": ".some-selector"
  },
  "story": { "id": "primitives-channelrow--active", "globals": "theme:signal;motion:reduced", "clip": ".d-chrow" }
}
```

- `viewport`: 1280x800 for desktop, 390x844 for phone.
- `prototype.props` are the prototype's component props (`startAt: 'signin' | 'app'`, `device: 'auto' | 'phone'`).
  The prototype reads them from the `data-props` attribute of its `script[data-dc-script]` (`parseDataProps` in
  `support.js`; each entry's `default` becomes `this.props`). The tool rewrites that attribute before the prototype's
  scripts run (a MutationObserver installed with `addInitScript`), so the file on disk is never modified.
- `prototype.steps` run in order after load: one of `click`, `rightClick`, `hover`, `waitFor` (selectors; `waitFor` waits up to 30s for a
  state the prototype reaches on its own clock, such as a speaker), `press` (a key), `type`
  (`[selector, text]`) or `wait` (ms) per step.
- `clip` (either side) crops to the first element matching the selector; without it the whole viewport is shot.
- `story.id` is the Storybook story id (`<title-slug>--<story-slug>`, see `storybook-static/index.json`).
  `story.globals` defaults to `theme:signal;motion:reduced`.
- Both sides run with `prefers-reduced-motion: reduce` at deviceScaleFactor 2, wait for `document.fonts.ready` and 600 ms.
  The prototype's Google Fonts requests are intercepted and answered with `@font-face` rules built from the repo's own
  `@fontsource-variable/jetbrains-mono` and `@fontsource/dm-serif-display` files, so no network is needed and both sides
  use the same font files.
- A `clip` crop gets 8px of padding on every side (both frames), so edges, rings and shadows are visible.

## The rule

A pair matches when **colour, size, spacing, radius, type and copy** agree. The contrast fixes in the plan's Global
Constraints (for example `--edge` instead of the prototype's `#2A303A` on controls whose border is their only boundary,
and `fg-3` text never on `surfaceHi`) are the only accepted deviations. Anything else that differs is a bug in the
story or component, not in the prototype.

## Shoot the running app instead of a story (`--app`)

A pair has `prototype` plus **either** `story` **or** `app`; one spec may mix both. An `app` side is the real web client:

```json
{ "name": "gap16-reminders-empty-due", "viewport": { "width": 1280, "height": 800 },
  "prototype": { "props": { "startAt": "app" }, "steps": [...] },
  "app": { "who": "ada", "path": "{server}", "steps": [{ "click": "role=button[name=\"Reminders\"s]" }], "clip": "...", "reset": "..." } }
```

- `who`: `ada`, `bjorn`, `mira`, `phone` are the world's browsers, attached over CDP (their window is emulated at the
  pair's viewport and scale 2 and restored afterwards); `fresh` and `freshPhone` are new signed-out contexts at
  `state.publicUrl` (1280x800 and 390x844 touch).
- `path` is opened before the steps. `{invite}` expands to `state.invitePath`, `{server}` to `#general` of the world's
  server, `{community}` to the server's own path (the phone's server list). Without a `path` the page stays where it is.
  After the capture the tool presses Escape twice and reloads `reset` (default: `path`, else the URL before the steps).
- Extra step kinds on top of the prototype ones: `{ "goto": "/path" }`, `{ "totp": [selector, who] }` (fills the next
  authenticator code of `state.people[who]`), `{ "upload": [selector, file...] }` (files relative to the repo, see
  `app/fixtures/`), `{ "dispatch": selector }` (a click event without hit testing). Typed text expands
  `{password:who}` and `{recoveryKey:who}` from `state.people`.
- Selectors on the app side can use Playwright roles: `role=button[name="Reminders"s]` (`s` = exact, `i` = case-insensitive).
- Output: `<name>.prototype.png`, `<name>.app.png`, `<name>.pair.png` (app on the right).

```
npm run ux:world -w @dilla/e2e -- --base 8611 --out target/ui-screens/signal-b   # waits for READY, keeps running
node docs/design/signal/parity/shoot.mjs docs/design/signal/parity/app/standing.json <outDir> --app [target/ui-screens/signal-b/state.json]
```

The world, its builds and ports are in `e2e/ux/README.md`. `app/standing.json` is the five standing whole screens (desktop
chat, members open, voice focus, phone list, phone conversation); `app/wave-a-gaps.json` is the wave A states that were
never compared with the shipped client.

**What is not judged.** The app's sample data (server Midgard Crew; Ada, Björn, Mira, Liv; timestamps, device names,
counts) differs from the prototype's (Mira, Ada, Björn, Kari, Ole, Glenn playing music). Compare styling, structure and
copy, not names. Other known capture differences: the prototype draws a phone frame around its 390px shots, uploads in
the app finish instantly (the prototype's progress bar is mid-way at capture), Giphy is unreachable from the world (the
picker shows its error state), and reduced motion (both sides) replaces animations such as the reply-jump flash.
