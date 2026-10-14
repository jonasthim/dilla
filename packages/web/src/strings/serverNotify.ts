// Flow 09 (docs/design/flows/09-roles-and-private-channels.md): roles and private channels copy. Keys: serverNotify.*
export const serverNotify = {
  'serverNotify.title': 'Servers',
  'serverNotify.body': 'A server’s setting applies to its channels unless a channel has its own.',
  'serverNotify.mode.default': 'default',
  'serverNotify.mode.all': 'all messages',
  'serverNotify.mode.mentions': 'mentions',
  'serverNotify.mode.nothing': 'nothing',
  'serverNotify.mute': 'mute server',
  'serverNotify.suppressEveryone': 'ignore @everyone and @here',
} as const;
