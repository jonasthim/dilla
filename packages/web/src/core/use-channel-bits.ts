import { channelBitsOf } from '@dilla/client-core';
import { useSlice } from './use-slice.ts';

/**
 * What I may do in one channel, from the roles, members, overwrites and access of its server (the resolver of
 * client-core, checked against the instance's own). `null` while anything is unknown, and for a DM: every caller then
 * behaves as before the roles existed. The answer is advisory; the instance decides each request again.
 */
export function useChannelBits(communityId: string | null, channelId: string | null): number | null {
  const key = communityId ?? '';
  const me = useSlice('account')?.user?.id ?? null;
  const communities = useSlice('communities');
  const roles = useSlice(`roles:${key}`);
  const members = useSlice(`members:${key}`);
  const overwrites = useSlice(`overwrites:${key}`);
  const access = useSlice(`permissions:${key}`);
  if (communityId === null || channelId === null || me === null) return null;
  const community = communities?.find(c => c.id === communityId);
  if (community === undefined || roles === undefined || members === undefined || overwrites === undefined || access === undefined) return null;
  if (!access.loaded || !access.overwritesLoaded || access.everyoneId === '') return null;
  return channelBitsOf({ owner: community.owner, everyoneId: access.everyoneId, roles, members, overwrites: overwrites[channelId] ?? [] }, me);
}
