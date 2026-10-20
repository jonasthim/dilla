// The built-in AFK channel's place in its run (web3.9 R42, R-AFK8), shared by the worker's admin controller and the page's
// channel list: AFK always stands last among its parent's channels at the server's reservation, and no move touches it.

/** The built-in AFK channel's position (R42, the server's AFKBuiltinPosition = 1 << 30): reserved by the server. */
export const AFK_BUILTIN_POSITION = 2 ** 30;

/** Whether a channel is the built-in AFK channel (R-AFK8). `afkId` is the `afk:` slice's channelId (null when the slice
 *  is unread, unknown or names no channel): with it, by id, so an ordinary channel at the reservation is not AFK; without
 *  it, the channel at exactly the reservation. */
export function isBuiltinAFK(id: string, position: number, afkId: string | null): boolean {
  return afkId !== null ? id === afkId : position === AFK_BUILTIN_POSITION;
}
