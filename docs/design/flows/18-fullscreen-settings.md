# Fullscreen user and server settings

Settings is a native modal workspace on desktop and phone. The shell, conversation
and media runtime remain mounted. Desktop uses a grouped 15rem sidebar and a
separately scrolling content pane, centered together within 80rem. The dialog itself
fills the viewport. Forms are limited to 48rem and lists to 64rem. Close remains
visible with its Escape hint. Phone uses the existing layout query, including the
landscape/coarse-pointer condition: index, then a section with Back to the index.
Phone tabs are hidden throughout settings; safe areas and visual viewport sizing
keep the footer above the keyboard. No additional settings breakpoint is used.

## Coverage inventory

| Scope / group | Section | Capabilities and implementation |
|---|---|---|
| Account | Profile | Display name, status message, biography, validation and server disclosure (`settings/Profile`) |
| Account | Sign-in | Password, TOTP, passkeys, recovery codes and existing reauthentication ceremonies (`settings/SignInFactors`, `PasswordDialog`, `StepUpDialog`) |
| Account | Devices | List, rename/revoke, recovery key, sign out and forget (`settings/Devices`, `KeyDialog`, `SignOut`) |
| Preferences | Appearance | Theme, existing density and reduced-motion preferences (`settings/Appearance`) |
| Preferences | Notifications | Browser permission, default behavior, sounds, server/channel overrides and mutes (`settings/Notifications`) |
| Preferences | Voice | Input/output devices, permission and unsupported states, input mode, PTT binding, noise processing, microphone test (`settings/Voice`, `MicrophoneTest`) |
| Preferences | Keyboard | Shortcut reference and link to editable voice bindings (`settings/Keyboard`) |
| Privacy & support | Privacy | Contact verification, changed keys and safety-number comparison (`settings/Privacy`, `Settings`) |
| Privacy & support | Diagnostics | Connection, instance/device facts, errors and copy (`settings/Diagnostics`) |
| User action | Sign out | Existing recovery-key sign-out ceremony, guarded before departure |
| Server | Overview | Name and AFK timeout (`admin/OverviewSection`) |
| Server | Channels | Categories, text/voice channels, ordering, editors and permissions (`admin/ChannelsSection`, `ChannelEditFlow`, `ChannelPermissions`) |
| Server | GIFs | Provider-key replacement/removal and rating (`admin/GifsSettings`) |
| People | Members | Browsing and existing role/moderation actions; cards scoped to settings (`admin/MembersSection`, `MemberPane`, `MemberCardHost`) |
| People | Roles | Create/edit/order/permissions (`admin/RolesSection`, `RoleEditorFlow`) |
| People | Invites | Existing creation and management (`admin/InvitesSection`) |
| People | Self-assignable roles | Personal selection, authorized configuration and panel publication (`admin/SelfRolesSection`) |
| Automation | Bot | Installation lifecycle, enable/disable, display name and capabilities |
| Automation | Welcome messages | Configuration, destination, preview and confirmed save |
| Automation | Join roles | Automatic role assignment to new members |
| Automation | Music | DJ roles, Spotify app configuration/linking and runtime provider observations |
| Moderation | Automoderation | Rules, actions, exemptions and configuration |
| Moderation | Moderation log | Automatic cases and manual evidence; separate journal |
| Moderation | Bans | Banned members and unban (`admin/BansSection`) |
| Server action | Ownership / Leave | Existing transfer/delete/leave restrictions (`admin/DangerSection`) |

Participant volume, screen-share volume, channel collapse and conversation-search
scope remain contextual controls. This reorganization does not move device-local
preferences into account/server storage or add personal provider accounts.

## Navigation and access

`/settings` is the phone index and desktop Profile. Existing `/settings/:section`
links, including privacy comparison history state, remain supported. Server roots
and sections use `/c/:communityId/settings` and `/c/:communityId/settings/:section`.
The Spotify callback stays `/settings/bot/music/spotify/callback`.

The registry in `packages/web/src/settings/registry.ts` is the source for navigation,
search and authorization. Loading permissions shows loading. Restricted pages are
never mounted just to search them. Members and personal self-roles remain available
to ordinary members; action permissions and role hierarchy remain authoritative in
the backend. Join-role editing requires community and role management. Moderation
logs require audit-log permission, separately from community management. On permission
loss, inaccessible drafts and content are cleared and the route selects an allowed page.

The originating conversation is retained independently of the selected section.
Desktop section navigation replaces the settings entry; phone index-to-section
navigation pushes. Indexed history restores the current entry while a draft prompt
is open, then replays the intended traversal after confirmation. Same-path history
state changes update route snapshots. Direct section links return to the index.

## Search, drafts and focus

Search uses labels, descriptions and curated synonyms, requiring every query term.
Exact labels rank before prefixes and other matches. Results show setting and section
breadcrumb. Search never indexes secrets, member names or current field values.
Enter opens a result after checking permissions again; Escape clears search first.
Results focus their setting anchor, falling back to the section heading. Ordinary
section changes focus the heading inside the workspace. Member cards never locate
matching anchors in the covered shell.

Immediate preferences show pending/error feedback. Configuration forms expose
`SettingsEditState` (dirty, busy, canSave, save, reset) to one Save/Reset footer.
Reset uses the latest confirmed baseline; refresh does not overwrite edits. Overview
tracks name and timeout separately so a partially successful save retries only the
failed operation. Independent key, authentication, linking, publication, invitation
and destructive operations retain named actions.

Section/search changes, Close, Escape, browser traversal, notifications, OAuth and
sign-out use Keep editing / Discard changes. Reload/departure uses beforeunload.
One prompt is open at a time. Accepted bot requests retain IDs, retry data and response
ownership at workspace level when the active section changes. Leaving does not cancel
an accepted request; acceptance is never presented as a confirmed save.

Announcements and incoming-call controls live inside the modal. Return to call is
guarded, and opening/closing settings does not end voice. Covered-content shortcuts
do not fire. Nested dialogs consume Escape first; closing restores opener focus or
a visible app fallback if the opener disappeared.

## Status evidence

Encrypted operation 24, `music.providers.status`, reads a versioned bounded runtime
snapshot with installation identity, observation time and fixed status/reason enums.
It reauthorizes community management and recomputes on replay. It does not play,
refresh OAuth, consume an authorization attempt or disclose credential material.

Spotify account reports Not linked / Linked / Needs attention / Unknown separately
from playback setup. Linked means valid installation-bound stored credentials, not
Premium, token acceptance or successful playback. Spotify and YouTube setup report
Configured / Missing requirements / Unknown. Callback success means Authorization
received; waiting for the bot and returns to Music for a fresh observation.
Reads poll once per second up to 30 seconds, with an OAuth reconciliation window up
to 60 seconds. Observations older than 60 seconds are stale with their timestamp.
Unsupported/offline bots show unavailable and Refresh while configuration stays usable.
Operation-filtered acknowledgements cannot consume other features' responses.

Real Spotify playback acceptance is separate from automated status-contract tests.
