# Flow 15: the GIF picker (E8)

An optional picker in the composer. It exists only when the operator set `giphy.api_key`; without a key there is no button and the routes answer 404. Search and the preview and full downloads go through the instance, so Giphy sees the instance and never a person. The picked GIF is attached like any file: it is encrypted like any file, and a reader's browser never contacts giphy.com.

## States

| State | UI |
|---|---|
| the instance has no Giphy key | no `gif` button in any composer |
| the instance has a Giphy key | a `gif` button (`gif.button`) after the attach `+`, in the channel, DM and thread composers |
| the composer is blocked (read-only, no permission) | the `gif` button is disabled with the rest of the composer |
| picker open, nothing typed | trending results; the search box (`gif.search`, placeholder `gif.search.placeholder`) is focused; `aria-expanded="true"` on the button |
| searching | `gif.loading` in the status line; results of the last search stay until the new ones arrive |
| results | a grid of three columns, one button per GIF named by its title (`gif.untitled` when it has none); a preview that is still downloading is a plain block |
| more results | the `gif.more` button under the grid |
| no results | `gif.empty` in the status line |
| the instance refused the search (key off, busy, rate limit) | `gif.error` in the status line, as an alert; typing again retries |
| a GIF picked | the picker shows `gif.picking` and ignores further picks; the full GIF is downloaded through the instance, then added to the file tray like a chosen file; the picker closes and focus goes to the message box |
| the pick failed | the picker stays open with `gif.pickFailed` |
| the GIF is in the tray | the tray shows it as an image file named `giphy-{id}.gif`; Enter in the message box sends it, with or without text; the tray's remove button drops it |
| a reader | sees an ordinary image attachment; nothing marks it as a GIF from a service |
| the picker footer | `gif.powered` |
| a phone | the picker is the width of the screen above the composer; results and buttons are 44px targets |

## Keyboard map

- `gif` button: Enter or Space toggles the picker; `aria-haspopup="dialog"`, `aria-expanded` follows, `aria-controls` names the picker while it is open
- Search box: ArrowDown enters the grid
- The grid is one tab stop that follows focus: Arrows move in two dimensions without wrapping, Home and End go to the ends, ArrowUp from the first row goes back to the search box
- A result: Enter, Space or a click picks it
- Escape closes the picker and returns focus to the `gif` button; it goes no further

## Focus rules

- Opening focuses the search box
- Escape returns focus to the `gif` button
- A pick moves focus to the message box, with the GIF in the tray
- A pointer down outside the picker closes it, except on the `gif` button, which toggles

## Announcements

- The status line is a polite status: it speaks `gif.loading`, `gif.empty`, `gif.picking` and `gif.pickFailed`
- A search failure speaks `gif.error` once
- A GIF added to the tray speaks `gif.added` through the shell announcer

## Copy

`gif.button='add a gif'`
`gif.picker='gifs'`
`gif.search='search gifs'`
`gif.search.placeholder='search giphy'`
`gif.untitled='gif'`
`gif.more='more'`
`gif.powered='Powered by GIPHY'`
`gif.loading='searching'`
`gif.empty='no gifs for that'`
`gif.error='could not reach the gif service'`
`gif.picking='adding the gif'`
`gif.pickFailed='could not add that gif'`
`gif.added='gif added. press enter to send.'`
