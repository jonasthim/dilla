# Music in chat

Enable the bot's Music capability in **Server settings → Bot**, and approve the
roles allowed to act as DJs. Owners and administrators can control playback
without a separate DJ-role grant. The bot needs permission to connect and speak in
the voice channel. Spotify account linking is in **Server settings → Music**; YouTube
requires the host's yt-dlp playback tools.

To let another member control music without making them an administrator:

1. Create a normal **DJ** role under **Server settings → Roles**.
2. Assign that role to the member.
3. Under **Server settings → Music → DJ roles**, select **DJ** and save.

DJ access is a bot role approval, not a checkbox in the role's permission list.

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
require current owner/admin authority or a configured DJ role, and presence in
that voice channel. Chat commands, including `/stop`, require a joined voice
channel to select their target. `/queue` is available to members with access to the call.
Commands in threads and edits to previous messages do not execute commands.

The bot's voice connection is for audio output only. It cannot subscribe to
people's microphone or screen-share tracks; the voice list labels it
**playback only**. This restriction is enforced by the server as well as the
music publisher.

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

Pause and Stop release the audio stream and its provider resources. The Bot can
remain silently in the voice channel so the next track does not disconnect and
rejoin. This connection lasts at most 30 minutes and ends when the Bot is disabled
or the channel is removed. A server disconnect stops playback; use a new playback
command to request a fresh connection.
