// Flow 12 (docs/design/flows/12-phone-shell.md): activity copy. Keys: activity.*
export const activity = {
  'activity.title': 'activity',
  'activity.emptyTitle': 'Nothing new',
  'activity.empty': 'Nothing new. Mentions and direct messages show up here.',
  'activity.mention': 'mentioned you in #{channel}',
  'activity.dm': 'direct message',
  'activity.elsewhere': 'unread elsewhere',
  'activity.since': 'Since this tab opened.',
  'activity.reminder': 'Reminder · {where}',
} as const;
