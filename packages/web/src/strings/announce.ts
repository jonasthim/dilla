// Flow 11 (docs/design/flows/11-slow-mode-announcements-threads.md): announcements copy. Keys: announce.*
export const announce = {
  'announce.kind': 'announcement',
  'announce.hint': 'Only the roles you tick can post. Everyone can read and react.',
  'announce.roles': 'Roles that can post',
  'announce.readOnly': 'Only some people can post in #{name}.',
  'announce.noRoles': 'No roles yet. Make one in Server settings, under roles.',
  'announce.noHeldRole': 'Tick a role of yours that is below your highest role, so that you can post here too.',
} as const;
