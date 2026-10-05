// Every user-visible string of @dilla/web. Keys are flat and dot-separated; {name} is a placeholder.
// Apostrophes are typographic (’). The copy lint (scripts/check-ui-copy.mjs) scans this file.
export const en = {
  'boot.loading.status': 'Starting dilla',
  'boot.unsupported.status': 'This window cannot keep dilla’s data',
  'boot.unsupported.detail': 'dilla needs storage that lasts. Private windows and some privacy settings turn it off. Open this address in a normal window.',
  'boot.otherTab.status': 'dilla is open in another tab',
  'boot.otherTab.detail': 'Use that tab, or close it. This tab takes over as soon as the other one closes.',
  'boot.storeLost.status': 'This browser can no longer open its saved data',
  'boot.storeLost.detail': 'The key that opens dilla’s storage in this browser is gone, so the account on this device cannot be used here. Resetting clears this browser so you can sign up again.',
  'boot.storeLost.action': 'Reset this browser',
  'boot.storeLost.confirmTitle': 'Reset this browser?',
  'boot.storeLost.confirmBody': 'This deletes dilla’s data for this site from this browser. It cannot be undone.',
  'boot.storeLost.confirmAction': 'Reset',
  'boot.resetting.status': 'Clearing this browser’s data',
  'boot.revoked.status': 'This browser was signed out',
  'boot.revoked.detail': 'Your account no longer accepts this browser. Ask the host if you did not expect this. To start over here, clear this site’s data in the browser’s settings.',
  'boot.error.status': 'dilla could not start',
  'boot.error.detail': 'Error {code}. Reload the page to try again.',
  'boot.error.action': 'Reload',
  'dialog.close': 'Close',
} as const;
