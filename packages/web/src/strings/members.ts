// Flow 08 (docs/design/flows/08-server-admin.md): server admin and moderation copy. Keys: members.*
export const members = {
  'members.toggle': 'members',
  'members.region': 'members of {server}',
  'members.group': '{name} — {count}',
  'members.groupMembers': 'members',
  'members.owner': 'owner',
  'members.you': 'you',
  'members.bot': 'bot',
  'members.actions': 'actions for {name}',
  'members.menu.message': 'message',
  'members.menu.compare': 'compare safety numbers',
  'members.menu.kick': 'kick',
  'members.menu.ban': 'ban',
  'members.loading': 'Loading members…',
  'members.empty': 'No one else is in this server yet.',
  'members.close': 'close members',
} as const;
