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

Join a voice channel and open the command picker by typing `/` at the start of a
community message. Choose a music command and fill its named fields, such as the
search query or URL for `play`. The composer validates required arguments and
permissions before sending. The complete music command list is in
[Bot commands](bot-commands.md).

Music results are private to the requester. Playback itself is heard in the
voice channel. One thing is public: when your `/play` starts the music, the bot
posts "{you} started music in {voice channel}" in the channel where you ran it,
with a live player card (title, who asked for it, progress, and the queue under
**Up next**). Everyone in that channel sees it. The card follows that track and
shows it finished once another plays or the bot leaves voice. The bot posts it
only for the person whose track just started, at most once a minute, and only in
a channel where that person may post. Queuing more tracks, pausing, skipping and
the other commands stay private.

While you are in the voice channel with the bot, the same player sits in your
voice panel and at the top of the voice stage. Its controls work for DJs, owners
and administrators who are in that voice channel; anyone else sees a note saying
why. Commands target the voice channel the requester joined. Playback changes
require current owner/admin authority or a configured DJ role, and presence in that
voice channel. The bot needs permission to connect and speak. Polls, reminders, and
other command results follow their own visibility rules in [Bot commands](bot-commands.md).

Typing `/play` or another slash expression into an ordinary message does not run
it. Use the command picker; to post slash text literally, choose **Send as text**
or prefix it with `//`. Edits, history replay, and bot-authored messages never run
music actions. Existing pending informational replies can still be recovered after
a bot restart, but old text commands are not resumed.

The bot's voice connection is for audio output only. It cannot subscribe to
people's microphone or screen-share tracks; the voice list labels it
**playback only**. This restriction is enforced by the server as well as the
music publisher.

Pause and Stop release the audio stream and its provider resources. The Bot can
remain silently in the voice channel so the next track does not disconnect and
rejoin. This connection lasts at most 30 minutes and ends when the Bot is disabled
or the channel is removed. A server disconnect stops playback; use a new playback
command to request a fresh connection.
