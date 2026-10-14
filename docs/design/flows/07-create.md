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
| start a server: creating | the submit says `create.server.busy` and is `aria-disabled`; a second Enter or click sends nothing | `createCommunity`, then `createChannel` text general, then voice general | none |
| start a server: refused | the field's error: `create.server.error.refused` (E_INVALID_REQUEST) or `create.server.error.other` | `createCommunity` refused | the error |
| start a server: channels failed | the server is listed and selected behind the dialog; the field gives way to a warn banner that names what is missing: `create.server.partialText` (#general), `create.server.partialVoice` (the voice general) or `create.server.partial` (both); focus moves to the submit, which says `create.server.retry` and adds only the channels still missing (the banner stays while it runs); closing keeps the server as it is (never a silent rollback) | the server exists; a `createChannel` was refused | the banner (`role="alert"`) |
| start a server: done | the dialog closes; the server is selected and `#general` opens; focus moves to its composer | `communities` lists the server (owner: this account) before `createCommunity` answers; each channel is listed before `createChannel` answers | none |
| server actions | under the server's name: `create.channel.button` (named `create.channel.open`) for the owner, `invite.open` for every member, in a group named `create.actions` | the owner is `communities[].owner`; the instance serves no role bits, so ownership is the one permission fact (the owner holds ManageChannels; `@everyone` holds CreateInvite by default) | none |
| new channel: idle | dialog `create.channel.title` with the kind group `create.channel.kind` (`create.channel.text`, `create.channel.voice`; selection follows the arrows) and the field `create.channel.name`; focus in the field; the hint says how the name will show (`create.channel.hintText` or `create.channel.hintVoice`, `create.channel.hint` while empty) | none | dialog title |
| new channel: refused | the field's error: `create.channel.error.empty`, `create.channel.error.long`, `create.name.control`, `create.channel.error.forbidden` (E_FORBIDDEN), `create.channel.error.refused` (E_INVALID_REQUEST) or `create.channel.error.other` | `createChannel` refused | the error |
| new channel: done | the dialog closes and the channel opens; a text channel's composer takes focus | the channel is listed before `createChannel` answers | none |
| invite: creating | dialog `invite.title` says `invite.creating` | `createInvite` with `INVITE_MAX_USES` and `INVITE_TTL_DAYS` | dialog title |
| invite: copied | the link in a read-only field `invite.link` (selected whole on focus) with `invite.copy`, described by `invite.limits` | the instance's own link, `<base>/i/<code>`, which the join dialog and the invite page accept | `invite.copied` in the dialog's status region |
| invite: clipboard blocked | as copied | the browser refused `clipboard.writeText` | `invite.blocked` in the status region |
| invite: refused | a danger banner `invite.error.forbidden` (E_FORBIDDEN) or `invite.error.other`, with `invite.retry` | `createInvite` refused | the banner (`role="alert"`) |
| another member's new channel | it shows when the window comes back to the tab (at most once in 15 s), on the next reconnect, or after a reload | the instance sends no event for a new channel | none |

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
│ Up to 255 bytes.                                    │   │                                                      │
│                              [Close esc] [Create]   │   │                                       [Close esc]    │
└─────────────────────────────────────────────────────┘   └──────────────────────────────────────────────────────┘
```

## 360×740

The rail stays a 60 px column, and the captions fit under its 40 px tiles. The sidebar stacks above the main pane, and the server actions wrap under the name. A dialog is at most `100vw − 32px` wide. The invite field and its copy button wrap onto two lines, and the field keeps the whole link: it scrolls, never an ellipsis.

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
| a server is started | the composer of its `#general`, once it is on screen | none |
| a text channel is added | its composer, once it is on screen | none |
| a voice channel is added, or a dialog is closed without creating | back to the opener | none |
| the invite link is copied (or the copy is blocked) | unchanged | `invite.copied` or `invite.blocked` |

## Announcements

The invite dialog has one `role="status"` region, present from its first render, so `invite.copied` is announced when it is set. A refusal in a create dialog is the field's `role="alert"`. A starter channel that failed is a warn banner (`role="alert"`). Nothing in this flow moves focus without a person's action.

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
- `create.server.name='Server name'`, `create.server.hint='Up to 255 bytes.'`
- `create.server.submit='Create'`, `create.server.busy='Creating…'`, `create.server.retry='Try again'`
- `create.server.error.empty='Give the server a name.'`, `create.server.error.long='That name is too long. A server name is up to 255 bytes.'`
- `create.server.error.refused='The server refused that name. Try another.'`, `create.server.error.other='Could not start the server ({code}). Try again.'`
- `create.server.partial='{name} is ready, but its channels were not added ({code}). Try again, or close this and add them from the channel list.'`
- `create.server.partialText='{name} is ready, but #general was not added ({code}). Try again, or close this and add it from the channel list.'`
- `create.server.partialVoice='{name} is ready, but its voice channel general was not added ({code}). Try again, or close this and add it from the channel list.'`
- `create.name.control='A name cannot hold control characters such as tabs or line breaks.'`

*New channel:*
- `create.channel.title='New channel in {server}'`, `create.channel.kind='Kind'`, `create.channel.text='text'`, `create.channel.voice='voice'`
- `create.channel.name='Channel name'`, `create.channel.hint='Up to 100 bytes.'`
- `create.channel.hintText='Shown as #{name}. Up to 100 bytes.'`, `create.channel.hintVoice='Shown as {name}. Up to 100 bytes.'`
- `create.channel.submit='Create'`, `create.channel.busy='Creating…'`
- `create.channel.error.empty='Give the channel a name.'`, `create.channel.error.long='That name is too long. A channel name is up to 100 bytes.'`
- `create.channel.error.forbidden='You cannot add channels to this server.'`, `create.channel.error.refused='The server refused that name. Try another.'`
- `create.channel.error.other='Could not add the channel ({code}). Try again.'`

*Invite:*
- `invite.title='Invite people to {server}'`, `invite.creating='Making an invite link…'`, `invite.link='Invite link'`, `invite.copy='copy link'`
- `invite.copied='Invite link copied.'`, `invite.blocked='This browser did not let dilla copy. Select the link and copy it yourself.'`
- `invite.limits='It can be used {uses} times and expires in {days} days. Anyone who has it can join {server}.'`
- `invite.retry='Try again'`, `invite.error.forbidden='You cannot invite people to this server.'`, `invite.error.other='Could not make an invite link ({code}).'`

An invite is spent once by each account that joins with it. A person who signs up through a server invite spends it twice: once to register and once to join the server. So with `INVITE_MAX_USES=10`, a link brings in five new people, or ten who already have an account.
