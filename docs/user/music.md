# Music in chat

Enable the bot's Music capability in **Server settings → Bot**, and approve the
roles allowed to act as DJs. The bot needs permission to connect and speak in
the voice channel. Spotify account linking stays in these settings; YouTube
requires the host's yt-dlp playback tools.

Join a voice channel, then send commands in a server text channel:

| Command | Result |
| --- | --- |
| `/play <song name>` | Queues the first YouTube search result and starts a paused queue. |
| `/play <YouTube or Spotify URL>` | Queues the track or playlist; starts a paused queue. |
| `/pause` | Pauses playback. |
| `/resume` | Resumes playback. |
| `/skip` | Advances to the next track. |
| `/queue` | Shows the current track and up to ten upcoming songs. |
| `/stop` | Stops playback. |
| `/music` | Shows command help. |

The bot answers in the same text channel, visible to everyone who can read it.
Commands target the voice channel the requester has joined. Playback changes
require a configured DJ role; an owner or administrator can also issue an
emergency stop. `/queue` is available to members with access to the call.
Commands in threads and edits to previous messages do not execute commands.

Commands and replies use the existing encrypted text transport. Bot-generated
messages never trigger commands. The daemon retains command receipts in its
encrypted native store: a failed reply upload retries the same response without
executing the command again. If the bot is interrupted during an action, it
reports the uncertain result and asks the user to inspect `/queue`; it does not
repeat an uncertain playback action automatically. Old commands from source
history do not restart playback.

An informational reply whose delivery becomes unknown after a server restore is
retained as uncertain and is not sent again; `/queue` can inspect the current
state. A send attempt definitively rejected after an encryption epoch change
gets a fresh attempt only after its closed receipt has been recorded.

The bot checks permission to reply in the text channel before executing a new
command. Definitive reply refusals are consumed durably so one channel cannot
block command intake elsewhere. Recently received commands from before the bot
started do not resume restored playback; pending replies for commands already
accepted before the restart can still finish.
