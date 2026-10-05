// The invite a person pastes: a bare code, an invite link (/i/<code>) or a /welcome?invite=<code> link.

const PATH_CODE = /\/i\/([^/?#\s]+)/;
const QUERY_CODE = /[?&]invite=([^&#\s]*)/;

function decoded(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** The invite code in `input`: the path segment after /i/, else the invite query value, else the trimmed input. */
export function extractInviteCode(input: string): string {
  const trimmed = input.trim();
  const path = PATH_CODE.exec(trimmed);
  if (path) return decoded(path[1]);
  const query = QUERY_CODE.exec(trimmed);
  if (query) return decoded(query[1].replace(/\+/g, ' '));
  return trimmed;
}
