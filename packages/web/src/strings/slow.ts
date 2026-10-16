// Flow 11 (docs/design/flows/11-slow-mode-announcements-threads.md): slow mode copy. Keys: slow.*
export const slow = {
  'slow.label': 'Slow mode',
  'slow.hint': 'How long each person waits between messages. People who may bypass slow mode do not wait.',
  'slow.off': 'off',
  'slow.s5': '5 seconds',
  'slow.s10': '10 seconds',
  'slow.s30': '30 seconds',
  'slow.m1': '1 minute',
  'slow.m5': '5 minutes',
  'slow.m15': '15 minutes',
  'slow.h1': '1 hour',
  'slow.h6': '6 hours',
  'slow.wait': 'Slow mode is on. You can send again in {time}.',
  'slow.queued': 'Waiting for slow mode, then sending.',
  'slow.badge': 'slow mode',
} as const;
