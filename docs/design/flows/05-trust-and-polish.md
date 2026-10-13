# Flow 05 — trust, search and device-local polish

This flow extends Flow 04's shell order: skip link → rail → channel list → header → log → composer → status bar. Chrome labels use lower case; ceremony and dialog copy uses sentence case. Every visible phrase below comes from the Copy table, with `{name}` filled from the contact's display name or username. Frame boxes describe width constraints, not pixel-perfect components.

## States

| state | shown action | worker fact | announcement |
|---|---|---|---|
| First seen here — not verified | `privacy.firstSeen` under the state; Compare with {name} | pin exists, verified=0, changedUmk=null | Privacy heading |
| changed | Compare with {name}; alert cannot dismiss; the composer of each conversation with that contact is blocked with the same text | changedUmk is validated pending key | `privacy.changed` |
| unlisted | no Verify | leaf is quarantined | `privacy.unlisted` |
| verified | show the compared key and date | exact current pin verified=1 | Privacy heading |
| no shared group | no Verify | shared=false | `privacy.noShared` |
| history pending | no Verify or send | list read not complete | `privacy.unlisted` |
| validated Remove | sending resumes only in this group; contact stays changed and unverified elsewhere | removed leaf absent from this group's current tree | `privacy.removed` |
| search loading | keep textbox and scope | current request id | `search.loading` |
| search empty | keep textbox and scope | current hits=[] | `search.noResults` |
| search stale | keep destination heading before closing palette | target absent/deleted/quarantined | `search.unavailable` |
| other tab waiting | no conversation view | no matching release/lock yet | `tabs.wait` |
| other tab failed or paused | retry or surviving heading | lock still owned or local pause failed | `tabs.failed` or `tabs.paused` |

First sight means first seen **here**, on this device. An instance may withhold newer signed lists, including on first sight; the first pin is not evidence that the list is current. An unknown history leaves the affected leaf pending and its message body unavailable. A validated Remove restores sending only in the group whose current tree no longer contains that leaf. The changed contact key stays unverified in other shared groups. A remote member can provoke repeated changed-key refusals, so a group-local Remove gives the honest sender a way to recover without approving that key.

Search has channel, community and all scopes. Loading retains the textbox and selected scope. An empty current request shows `search.noResults`; an older response cannot replace a newer one. A result opens its channel, then focuses the target row only after the timeline publishes that row. If the target is missing, deleted or quarantined, announce `search.unavailable`, focus a persistent channel heading or palette textbox, and only then remove the overlay. Search hits never expose quarantined text.

Appearance, Keyboard and Diagnostics settings are device-local. Diagnostics displays connection, generation, the instance name (as the status bar shows it), own-device count and the last 20 stable codes with their times; with none it says `diagnostics.empty`. `diagnostics.copy` copies codes only, with no details, tokens or message bodies. Typing is deduplicated by user: one user maps to `typing.one`, multiple users to `typing.many`, even when one user has multiple devices. The other tab has `other-tab` (the `tabs.use` action), waiting, busy, failed, paused and ready phases. Busy keeps the waiting surface while accepted work drains; ready appears only after the old lock releases and this tab acquires it. Failed or paused does not claim release. No follower conversation or message view is rendered.

## 1280×800

```text
┌──────────────────────┬──────────────────────────────────────────────────────────────────────────────────┐
│channels              │Privacy      Search your messages [this conversation ▾]                           │
│                      │First seen here — not verified                                                    │
│                      │This is the first key this device saw for Ada. The server could have shown a      │
│                      │different one. Compare numbers to verify.                                         │
│                      │[Compare with Ada]                                                                │
│                      │ ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓     │
│                      │ ┃Compare safety numbers · Ada                                              ┃     │
│                      │ ┃First seen here — not verified                                            ┃     │
│                      │ ┃This is the first key this device saw for Ada. The server could have      ┃     │
│                      │ ┃shown a different one. Compare numbers to verify.                         ┃     │
│                      │ ┃public UMK: 4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a                              ┃     │
│                      │ ┃            4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a                              ┃     │
│                      │ ┃00000 00000 00000 00000 00000 00000                                       ┃     │
│                      │ ┃00000 00000 00000 00000 00000 00000                                       ┃     │
│                      │ ┃Open Privacy on both devices. Read the 12 blocks of five digits to each   ┃     │
│                      │ ┃other in person or on a call you started yourself.                        ┃     │
│                      │ ┃[Copy number]  □ Yes, all 12 blocks match                                 ┃     │
│                      │ ┃[All 12 blocks match] [Close]                                             ┃     │
│                      │ ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛     │
└──────────────────────┴──────────────────────────────────────────────────────────────────────────────────┘
```

## 360×740

```text
┌────────────────────────────────────┐
│Privacy                       [Back]│
│First seen here — not verified      │
│This is the first key this device   │
│saw for Ada. The server could have  │
│shown a different one. Compare      │
│numbers to verify.                  │
│[Compare with Ada]                  │
│ ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓   │
│ ┃Compare safety numbers · Ada  ┃   │
│ ┃First seen here — not verified┃   │
│ ┃This is the first key this    ┃   │
│ ┃device saw for Ada. The       ┃   │
│ ┃server could have shown a     ┃   │
│ ┃different one. Compare        ┃   │
│ ┃numbers to verify.            ┃   │
│ ┃public UMK                    ┃   │
│ ┃4a4a4a4a4a4a4a4a              ┃   │
│ ┃4a4a4a4a4a4a4a4a              ┃   │
│ ┃4a4a4a4a4a4a4a4a              ┃   │
│ ┃4a4a4a4a4a4a4a4a              ┃   │
│ ┃00000 00000 00000 00000       ┃   │
│ ┃00000 00000 00000 00000       ┃   │
│ ┃00000 00000 00000 00000       ┃   │
│ ┃Open Privacy on both          ┃   │
│ ┃devices. Read the 12 blocks   ┃   │
│ ┃of five digits to each other  ┃   │
│ ┃in person or on a call you    ┃   │
│ ┃started yourself.             ┃   │
│ ┃[Copy number]                 ┃   │
│ ┃□ Yes, all 12 blocks match    ┃   │
│ ┃[All 12 blocks match] [Close] ┃   │
│ ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛   │
│search [this conversation ▾]        │
│[Search your messages]              │
└────────────────────────────────────┘
```

The real dialog renders the **exact 64-hex-character public UMK**, in full, and the pairwise number as **12 five-digit blocks**, separated by single spaces. The repeated `4a` and zero blocks above are layout examples, not a key or number to verify. The dialog identifies the contact and first-seen, changed, verified or unlisted state. For first-seen, `privacy.firstSeen` appears under the state on the Privacy page and in the dialog. Both people independently open Privacy on their own devices and read every block to each other in person or on a call one of them started themselves. A number copied by one person is an aid, not a confirmation; Copy leaves `privacy.confirm` unchecked. The `privacy.verify` button is available only when that checkbox is checked, there is a shared group, and the exact validated pending public key remains the one shown. If there is no shared group, show `privacy.noShared` without Verify.

The browser-tier device depends on code served by its instance. Comparing the safety number outside that instance through this ceremony is the user's available check of the displayed identity; this flow makes no promise about the browser-served code. A malicious instance can freeze the first list seen here. A validated Remove unblocks only this group.

Use Mesh's mono/terminal hierarchy, `--bg`, `--surface`, `--fg`, `--fg-2`, `--edge` and `--accent` roles in `mesh`, `light` and `high-contrast`; the same structure and state text appear in all three themes. At 360 CSS pixels, dialog width is bounded by `max-width:min(100vw - 32px, …)`, the public key wraps, controls wrap inside the viewport, and the viewport has no horizontal scroll. Checkbox, buttons and every close control have targets at least 24×24 CSS pixels. At 200% zoom/reflow, no control or text is lost and every focus ring remains visible: `outline: var(--focus-ring)` with a 2px offset. Reduced motion suppresses transition effects without hiding or changing any state.

## Keyboard map

| starting focus | action | destination |
|---|---|---|
| shell | Ctrl/⌘+K | search textbox, scope preserved |
| conversation | Ctrl+/ | search textbox, channel scope |
| compare opener | Enter/Space | dialog heading, then first control |
| inside compare | Tab/Shift+Tab | next/previous control inside dialog; wraps |
| compare Copy | Enter/Space | Copy button; checkbox stays unchecked |
| compare checkbox | Space | checkbox checked; Verify enabled only if pending key and shared group |
| any top overlay | Escape outside IME composition | surviving opener; dialog closes |
| search hit | Enter/Space | loaded target row, or channel heading if unavailable |
| changed alert action | Enter/Space | compare dialog heading |
| use this tab | Enter/Space | waiting heading, then ready heading only after lock acquisition |

There is no unmodified global shortcut. These shortcuts do not interrupt IME composition. Flow 04's row, toolbar, composer and dialog order still applies beneath these overlays.

## Focus rules

| transition | focus destination | polite status |
|---|---|---|
| compare closes | original Compare button if present, else Privacy heading | no extra text |
| changed alert replaces first-seen row | surviving Compare button | `privacy.changed` |
| validated Remove clears this group's send block | surviving composer in this group if present, else conversation heading; other groups keep their changed-key block | `privacy.removed` |
| search hit disappears | channel heading or persistent palette textbox before unmount | `search.unavailable` |
| tab waits, becomes ready, pauses or fails | heading of the new state or Retry control | `tabs.wait` / ready state / `tabs.paused` / `tabs.failed` |
| typing one to many | current conversation; do not steal focus | `typing.one` / `typing.many` |

The compare dialog traps focus and returns it to a surviving opener on close. Activating Compare in a changed alert first focuses the dialog heading; subsequent Tab reaches the first control. If an alert is replaced, focus moves to the surviving Compare control. A tab transition focuses the new state's persistent heading or Retry control, never a removed conversation control.

## Announcements

`role="status"` is polite for search loading/unavailable, typing and tab transitions. A changed-key alert uses the existing alert semantics but does not repeatedly announce on unchanged slices. Cannot-read rows have neutral visible text; their stable code is available only in Diagnostics. At reduced motion, no animation is needed to tell any state apart.

## Copy

| key | English | placement |
|---|---|---|
| settings.nav.privacy | privacy | settings nav |
| settings.nav.keyboard | keyboard | settings nav |
| settings.nav.diagnostics | diagnostics | settings nav |
| privacy.section | Privacy | Privacy heading |
| privacy.compare | Compare with {name} | contact row |
| privacy.title | Compare safety numbers | dialog title |
| privacy.copy | Copy number | dialog button |
| privacy.verify | All 12 blocks match | dialog final button |
| privacy.instructions | Open Privacy on both devices. Read the 12 blocks of five digits to each other in person or on a call you started yourself. | dialog instructions |
| privacy.confirm | Yes, all 12 blocks match | dialog checkbox |
| privacy.firstSeen | This is the first key this device saw for {name}. The server could have shown a different one. Compare numbers to verify. | under first-seen state on Privacy page and in dialog |
| privacy.firstSeenLabel | First seen here — not verified | first-seen state label on Privacy page and in dialog |
| privacy.verifiedLabel | verified | verified state label beside the compared key |
| privacy.changed | This contact’s identity changed. Compare the number before sending. | changed alert; reason under the blocked composer of that conversation |
| privacy.unlisted | This device is not on the contact’s list. | unlisted state |
| privacy.noShared | Open a conversation with this person to compare numbers. | no shared group |
| privacy.removed | You can send in this conversation after this member leaves. Their changed identity is still unverified elsewhere. | group recovery |
| search.open | search | shell action |
| search.placeholder | Search your messages | palette textbox |
| search.empty | No messages found | global empty state |
| search.unavailable | That message is no longer available | stale result status |
| search.loading | Searching your messages | palette status |
| search.noResults | No results in this scope | scope empty state |
| search.scope.channel | this conversation | scope option |
| search.scope.community | this community | scope option |
| search.scope.all | everything | scope option |
| keyboard.searchAll | Ctrl/⌘+K | Keyboard settings, opens search |
| keyboard.searchChannel | Control+/ | Keyboard settings, searches this conversation |
| diagnostics.title | Diagnostics | heading |
| diagnostics.copy | Copy codes | diagnostics action |
| diagnostics.connection | connection | diagnostics field |
| diagnostics.generation | generation | diagnostics field |
| diagnostics.instance | instance | diagnostics field |
| diagnostics.devices | devices | diagnostics field (own-device count is its value) |
| diagnostics.empty | No errors recorded | diagnostics, no stored code |
| tabs.use | Use this tab | follower action |
| tabs.wait | Moving to this tab… | waiting status |
| tabs.failed | Close the other tab, then try again. | failure status |
| tabs.paused | This tab is paused | paused heading |
| typing.one | {name} is typing | conversation status |
| typing.many | Several people are typing | conversation status |
