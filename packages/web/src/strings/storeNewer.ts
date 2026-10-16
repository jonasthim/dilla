// Flow 01 (docs/design/flows/01-onboarding.md, Copy): the boot splash for a store a newer version of dilla wrote
// (E_STORE_NEWER, C4x in v0.1.0-web3.6). Keys: boot.storeNewer.*
export const storeNewer = {
  'boot.storeNewer.status': 'This version of dilla is too old for the data saved in this browser',
  'boot.storeNewer.detail': 'That data needs data version {found}; this version of dilla reads up to {supported}. Update to the newer version of dilla, or ask the host of this server.',
  'boot.storeNewer.action': 'Reload',
} as const;
