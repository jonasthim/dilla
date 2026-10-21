/**
 * WebKit's line for a fetch it cancelled because the page went away under it (a navigation or a reload). The origin
 * is the app's own, so no CORS check applies: WebKit words every cancelled fetch "due to access control checks".
 */
export const WEBKIT_CANCELLED_FETCH_LINE = /^Fetch API cannot load http:\/\/127\.0\.0\.1:\d+\/v1\/.* due to access control checks\.$/;
export const ABORT_WINDOW_MS = 3000;

/** Only the webkit-web project prints this line for a cancelled fetch, and only this exact line is ever excused. */
export function isCancelledFetchLine(text: string, projectName: string): boolean {
  return projectName === 'webkit-web' && WEBKIT_CANCELLED_FETCH_LINE.test(text);
}

/**
 * Whether a console error is WebKit's cancelled-fetch line landing next to a navigation or resize of its page:
 * within ABORT_WINDOW_MS of `lastDisturbedAt` (null: none seen on that page).
 */
export function isNavigationAbortLine(text: string, projectName: string, now: number, lastDisturbedAt: number | null): boolean {
  return isCancelledFetchLine(text, projectName) && lastDisturbedAt !== null && now - lastDisturbedAt <= ABORT_WINDOW_MS;
}
