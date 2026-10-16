# Flow 07 — start a server, add a channel, invite people

This flow makes a fresh instance usable from the web client alone (v0.1.0-web3.1). The first person signs up with the bootstrap invite and lands in an empty shell. From there they start a server, which comes with `#general` and a voice channel called general. They copy an invite link and send it to a friend, who signs up through it and lands in the same server. The flow extends Flow 04's shell order: skip link → rail (servers, then **join**, then **new**, then settings) → sidebar (server name, **server actions**, tabs, rows) → header → log → composer → status bar.

Chrome labels use lower case and dialog copy uses sentence case; nothing ends in an exclamation mark. *Server* names a community. Every visible phrase below comes from the Copy section. `{name}` is a name the person typed, `{server}` the server's name and `{code}` a refusal code. Nothing in this flow says how messages are protected. A new text channel is one the server cannot read, as every channel the web client creates; its group is registered by the first device that opens it, and a voice channel's call group by its first call.

## States

| state | shown | worker fact | announcement |
|---|---|---|---|
| no server | main pane: `shell.noServer.title`, `shell.noServer.body`, with `shell.noServer.create` (accent) and `shell.noServer.action`; the sidebar stands on the DMs tab with `shell.dms.new`; the rail shows `create.rail.join` and `create.rail.new` | `communities` is empty | none |
| picker, no server | the picker says `shell.dms.noServer` and lists no one | `communities` is empty | dialog title |
| picker, alone | the picker says `shell.dms.alone` and lists no one | the selected server lists no member but this account | dialog title |
| start a server: idle | dialog `create.server.title` with `create.server.body` and the field `create.server.name` (hint `create.server.hint`); focus in the field | none | dialog title |
| start a server: refused before sending | the field's error: `create.server.error.empty`, `create.server.error.long` or `create.name.control`; focus stays in the field | none: nothing is sent | the error (`role="alert"`) |
| start a server: creating | the submit says `create.server.busy` and is `aria-disabled`; a second Enter or click sends nothing; a dialog closed and opened again while the create runs still says `create.server.busy` until it ends, and that create no longer changes the dialog | `createCommunity`, then `createChannel` text general, then voice general | `create.server.busy` in the dialog's visually hidden status region |
| start a server: refused | the field's error: `create.server.error.refused` (E_INVALID_REQUEST, or the worker's own name check E_BAD_INPUT) or `create.server.error.other`; the same refusal again is a new alert | `createCommunity` refused | the error |
| start a server: answer lost | when `createCommunity` fails with E_NETWORK, the page has the worker read the server list again (`refreshCommunities`, also with the socket up) and looks in `communities` for a server this account owns, named exactly as typed, that was not listed before the press: exactly one found, it is that server, adopted as if the create had answered (selected, then its starters); two or more found, none is adopted and the field says `create.server.error.ambiguous` (no create is sent, on that press or a later one); not found, the field says `create.server.error.other`. A later Create with the same name reads the list again first and looks again (against the list from before the first press); only when that read succeeds and finds nothing does it create, and a read that fails sends no create and says its code, so a second press never makes a second server | `refreshCommunities` publishes `communities` before it answers | the error, while not found |
| start a server: closed while its channels are added | the server's create carries on; a starter that fails after the close is kept by `communityId` for the page session, and the next open of Start a server (or the dialog, if it was opened again meanwhile, once that create ends) shows its banner, as in "channels failed", once: closing again without the retry drops it, and the channel list is where to add it then | the server exists; a `createChannel` was refused after the close | the banner |
| start a server: channels failed | the server is listed and selected behind the dialog; the field gives way to a warn banner that names what is missing: `create.server.partialText` (#general), `create.server.partialVoice` (the voice general) or `create.server.partial` (both); focus moves to the submit, which says `create.server.retry`, reads the server's channels again (a create whose answer was lost may have made its channel; a listed starter counts as made) and adds only the channels still missing (the banner stays while it runs; a failed read sends no create and names its code); closing keeps the server as it is (never a silent rollback) | the server exists; a `createChannel` was refused | the banner (`role="alert"`) |
| start a server: done | the dialog closes; the server is selected and `#general` opens; focus moves to its composer | `communities` lists the server (owner: this account) before `createCommunity` answers; each channel is listed before `createChannel` answers | none |
| server actions | under the server's name: `create.channel.button` (named `create.channel.open`) for the owner, `invite.open` for every member, in a group named `create.actions` | the owner is `communities[].owner`; the instance serves no role bits, so ownership is the one permission fact (the owner holds ManageChannels; `@everyone` holds CreateInvite by default) | none |
| new channel: idle | dialog `create.channel.title` with the kind group `create.channel.kind` (`create.channel.text`, `create.channel.voice`; selection follows the arrows) and the field `create.channel.name`; focus in the field; the hint says how the name will show (`create.channel.hintText` or `create.channel.hintVoice`, `create.channel.hint` while empty) | none | dialog title |
| new channel: creating | the submit says `create.channel.busy` and is `aria-disabled`; a second Enter or click sends nothing; as for a server, a reopened dialog says `create.channel.busy` until an earlier create ends, and that create neither changes the dialog nor opens its channel | `createChannel` | `create.channel.busy` in the dialog's visually hidden status region |
| new channel: taken | the field's error: `create.channel.error.takenText` or `create.channel.error.takenVoice`, when the server's list already holds a channel of the chosen kind whose name is the one shown in the hint (a text name as its slug); focus stays in the field | none: nothing is sent (dillad keeps no uniqueness on channel names) | the error |
| new channel: refused | the field's error: `create.channel.error.empty`, `create.channel.error.long`, `create.name.control`, `create.channel.error.forbidden` (E_FORBIDDEN), `create.channel.error.refused` (E_INVALID_REQUEST only) or `create.channel.error.other` (any other code, the worker's E_BAD_INPUT included); the same refusal again is a new alert | `createChannel` refused | the error |
| new channel: done | the dialog closes and the channel opens; a text channel's composer takes focus; its empty log says `shell.log.emptyMade`, not `shell.log.empty`, since nothing in it predates this browser (as for the starters of a server started here), for the page session | the channel is listed before `createChannel` answers | none |
| invite: creating | dialog `invite.title` says `invite.creating` | `createInvite` with `INVITE_MAX_USES` and `INVITE_TTL_DAYS`, unless this page already made a link for the server with more than a day of it left: that link is shown again (an open, and a switch between servers, mint nothing new); `invite.limits` then counts the days left, rounded up | dialog title |
| invite: copied | the link in a read-only field `invite.link` (selected whole on focus) with `invite.copy`, described by `invite.limits`; the page copies it by itself only when the link is at hand within `AUTO_COPY_MS` (1 s) of the open | the instance's own link, `<base>/i/<code>`, which the join dialog and the invite page accept | `invite.copied` in the dialog's status region |
| invite: answer slow | as copied, but nothing is copied and the status region stays empty, never `invite.blocked`: past `AUTO_COPY_MS` the browser no longer counts the open as the person's press; `invite.copy` copies inside their own press | `createInvite` answered after `AUTO_COPY_MS` | none |
| invite: clipboard blocked | as copied; `invite.copy` tries again inside the person's own press, which a browser that refused the copy after the round trip (Safari, Firefox) allows | the browser refused `clipboard.writeText`, or has no clipboard | `invite.blocked` in the status region |
| invite: refused | a danger banner `invite.error.forbidden` (E_FORBIDDEN) or `invite.error.other`, with `invite.retry`; the same refusal again is a new alert | `createInvite` refused | the banner (`role="alert"`) |
| another member's new channel, or a renamed server | it shows within about a second in every member's open tab: the instance sends op 54 `community_changed`, and the worker, after a 250 ms wait that folds a burst into one, reads the server list (a new name in the rail) and that server's channels and members again. The window coming back to the tab also reads the lists (at most once in 15 s; a return inside that window schedules one read at its end, which a hidden tab skips), as do a reconnect and a reload: the fallback for a notice the tab missed | op 54 `community_changed [community_id]`, after a channel is created, updated or deleted, or the server is patched | none |

A text channel's name is stored as a lower-case slug: runs of spaces become one `-`, and letters outside ASCII stay (`Fika på Fredag` is `#fika-på-fredag`). A voice channel's name is kept as typed, trimmed, with runs of spaces made one. Names are checked before sending as the instance checks them: not blank, at most 255 UTF-8 bytes for a server and 100 for a channel, and no control character.

## 1280×800

```text
┌────┬───────────────────────────┬─────────────────────────────────────────────────────────────────────────┐
│ MC │ Midgard Crew              │ # general                                                               │
│    │ [+ channel] [invite link] │                                                                         │
│┄┄┄┄│───────────────────────────│                                                                         │
│ ⇥  │ channels · direct messages│                                                                         │
│join│ # general                 │                                                                         │
│ +  │ voice                     │                                                                         │
│new │ ◉ general                 │                                                                         │
│────│                           │ message #general                                                        │
│ ⚙  │                           │                                                                         │
└────┴───────────────────────────┴─────────────────────────────────────────────────────────────────────────┘
```

The two action tiles end the server list. Each is a dashed square with a caption under it: **join** in the edge colour and **new** in the accent, because starting a server is how a fresh instance begins. The server actions sit on one row under the server's name, above the tabs. The dialogs are the Mesh dialog of Flow 04 (mono, accent border, `esc` close on the left of the footer, the accent action on the right).

```text
┌ Start a server ─────────────────────────────────────┐   ┌ Invite people to Midgard Crew ──────────────────────┐
│ You own it: you add its channels and invite people. │   │ INVITE LINK                                          │
│ It starts with a text channel and a voice channel,  │   │ [https://chat.example.org/i/7KQ2-M4ZP… ] [copy link] │
│ both called general.                                │   │ It can be used 10 times and expires in 7 days.       │
│ SERVER NAME                                         │   │ Anyone who has it can join Midgard Crew.             │
│ [Midgard Crew                                    ]  │   │ › Invite link copied.                                │
│ Up to 255 characters (fewer for some letters).                                    │   │                                                      │
│                              [Close esc] [Create]   │   │                                       [Close esc]    │
└─────────────────────────────────────────────────────┘   └──────────────────────────────────────────────────────┘
```

## 360×740

The rail stays a 60 px column, and the captions fit under its 40 px tiles. The sidebar stacks above the main pane, and the server actions sit under the name. They are compact buttons (28 px tall, 6 px sides), so both fit on one row in the 240 px sidebar at 1280 too; they wrap only when a larger text size leaves no room. A long name never widens the page, at either width: the channel header cuts it with an ellipsis and keeps its closing bracket and its actions (**pinned**) on screen, the composer's label line cuts it the same way, and the rows, the server title and the voice dock already do. A dialog is at most `100vw − 32px` wide. The invite field and its copy button wrap onto two lines, and the field keeps the whole link: it scrolls, never an ellipsis.

## Keyboard map

| starting focus | action | destination |
|---|---|---|
| the rail (one roving stop) | Down/Up, Home/End | servers, then `create.rail.join`, then `create.rail.newLabel`, then settings |
| `create.rail.newLabel` | Enter/Space | opens Start a server, focus in the name field |
| a create dialog's field | Enter | submits; while busy, nothing more is sent |
| the kind group | Left/Right or Up/Down | moves and selects (wraps); one tab stop |
| any create dialog | Escape | closes; focus returns to what opened it |
| the server actions | Tab | each action is its own stop, before the tabs |
| the invite field | focus | selects the whole link |

## Focus rules

| transition | focus destination | polite status |
|---|---|---|
| a create dialog opens | its name field (the invite dialog: the dialog, then Tab reaches the link) | dialog title |
| a submit is refused before or after sending | the field, which holds the error | the error (`role="alert"`) |
| a starter channel failed (the field gives way to the banner) | the submit, which now says `create.server.retry` | the banner (`role="alert"`) |
| a server is started | the composer of its `#general`, once it is on screen (dropped if another conversation opens first) | none |
| a text channel is added | its composer, once it is on screen (dropped if another conversation opens first) | none |
| a voice channel is added, or a dialog is closed without creating | back to the opener | none |
| the invite link is copied (or the copy is blocked) | unchanged | `invite.copied` or `invite.blocked` |

## Announcements

The invite dialog has one `role="status"` region, present from its first render, so `invite.copied` is announced when it is set. The two create dialogs each have a visually hidden `role="status"` region, also present from the first render, which says `create.server.busy` or `create.channel.busy` while a create runs: Enter keeps focus in the field, so the submit's new name alone is not heard. A refusal or notice the same as the last one is drawn as a new alert, so it is announced again. A refusal in a create dialog is the field's `role="alert"`. A starter channel that failed is a warn banner (`role="alert"`). Nothing in this flow moves focus without a person's action.

## Copy

Every key below is one string of `packages/web/src/strings/en.ts`, byte for byte (`packages/web/src/strings/strings.test.ts` checks it). The constants are in `packages/web/src/screens/Create.tsx`: `INVITE_MAX_USES=10` and `INVITE_TTL_DAYS=7`, which fill `{uses}` and `{days}`.

*Empty states and the picker:*
- `shell.noServer.title='You are not in a server yet'`, `shell.noServer.body='Start a server and invite your friends, or join one with an invite someone sent you.'`
- `shell.noServer.create='Start a server'`, `shell.noServer.action='Join a server'`
- `shell.dms.noServer='There is no one to message yet: direct messages are with people you share a server with. Start a server and invite someone, or join one.'`
- `shell.dms.alone='No one else is in this server yet. Invite people first, then message them here.'`

*Rail and server actions:*
- `create.rail.join='join'`, `create.rail.new='new'`, `create.rail.newLabel='new server'`
- `create.actions='server actions'`, `create.channel.button='channel'`, `create.channel.open='new channel'`, `invite.open='invite link'`

*Start a server:*
- `create.server.title='Start a server'`
- `create.server.body='You own it: you add its channels and invite people. It starts with a text channel and a voice channel, both called general.'`
- `create.server.name='Server name'`, `create.server.hint='Up to 255 characters (fewer for some letters).'`
- `create.server.submit='Create'`, `create.server.busy='Creating…'`, `create.server.retry='Try again'`
- `create.server.error.empty='Give the server a name.'`, `create.server.error.long='That name is too long. A server name is up to 255 characters (fewer for some letters).'`
- `create.server.error.refused='That name was refused. Try another.'`, `create.server.error.other='Could not start the server ({code}). Try again.'`
- `create.server.error.ambiguous='More than one new server of yours is named {name}. Open the one you meant from the server list.'`
- `create.server.partial='{name} is ready, but its channels were not added ({code}). Try again, or close this and add them from the channel list.'`
- `create.server.partialText='{name} is ready, but #general was not added ({code}). Try again, or close this and add it from the channel list.'`
- `create.server.partialVoice='{name} is ready, but its voice channel general was not added ({code}). Try again, or close this and add it from the channel list.'`
- `create.name.control='A name cannot hold control characters such as tabs or line breaks.'`

*New channel:*
- `create.channel.title='New channel in {server}'`, `create.channel.kind='Kind'`, `create.channel.text='text'`, `create.channel.voice='voice'`
- `create.channel.name='Channel name'`, `create.channel.hint='Up to 100 characters (fewer for some letters).'`
- `create.channel.hintText='Shown as #{name}. Up to 100 characters (fewer for some letters).'`, `create.channel.hintVoice='Shown as {name}. Up to 100 characters (fewer for some letters).'`
- `create.channel.submit='Create'`, `create.channel.busy='Creating…'`
- `create.channel.error.empty='Give the channel a name.'`, `create.channel.error.long='That name is too long. A channel name is up to 100 characters (fewer for some letters).'`
- `create.channel.error.forbidden='You cannot add channels to this server.'`, `create.channel.error.refused='That name was refused. Try another.'`
- `create.channel.error.other='Could not add the channel ({code}). Try again.'`
- `create.channel.error.takenText='There is already a text channel called #{name}. Try another.'`
- `create.channel.error.takenVoice='There is already a voice channel called {name}. Try another.'`
- `shell.log.emptyMade='nothing here yet.'` in place of `shell.log.empty='nothing here yet. Messages sent before this browser joined are not shown.'`

*Invite:*
- `invite.title='Invite people to {server}'`, `invite.creating='Making an invite link…'`, `invite.link='Invite link'`, `invite.copy='copy link'`
- `invite.copied='Invite link copied.'`, `invite.blocked='This browser did not copy the link. Press copy link to try again, or select the link and copy it yourself.'`
- `invite.limits='It can be used {uses} times and expires in {days} days. Anyone who has it can join {server}.'`
- `invite.retry='Try again'`, `invite.error.forbidden='You cannot invite people to this server.'`, `invite.error.other='Could not make an invite link ({code}).'`
- `invite.options='more options'`

An invite is spent once by each person who joins with it, whether they sign up through it or already have an account. So with `INVITE_MAX_USES=10`, one link brings in up to ten people.
