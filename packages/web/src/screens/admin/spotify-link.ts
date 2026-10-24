/** Starts the external authorization only after the short-lived attempt has been recorded for this tab. */
export function authorizeSpotify(url: string): void {
  window.location.assign(url);
}

export const spotifySession = {
  getItem(key: string): string | null {
    // eslint-disable-next-line no-restricted-properties -- the linking flow explicitly requires IDs and CSRF state only
    return window.sessionStorage.getItem(key);
  },
  setItem(key: string, value: string): void {
    // eslint-disable-next-line no-restricted-properties -- the linking flow explicitly requires IDs and CSRF state only
    window.sessionStorage.setItem(key, value);
  },
  removeItem(key: string): void {
    // eslint-disable-next-line no-restricted-properties -- clear the one content-free Spotify attempt record
    window.sessionStorage.removeItem(key);
  },
  clear(): void {
    // eslint-disable-next-line no-restricted-properties -- clear the content-free record in isolated tests
    window.sessionStorage.clear();
  },
};
