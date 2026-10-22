import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { BASELINE_TAG, notesNewestFirst, sfuRestart, treeLevels } from './release-meta.mjs';

/**
 * Part of check:ci. The newest release notes that carry a "Media server (SFU)" row in their Versions table must agree
 * with the sfu_restart that release.yml will compute for them: the same rule (scripts/release-meta.mjs) over the tree's
 * min_sfu_media_level (internal/sfu/level.go) and the previous release's level. The previous release is the next older
 * notes file with such a row (its first "level N" is its media level); with none, there is no release.json before it, so it
 * is v0.1.0-web3.11 at media level 1. Notes without the row are not checked here (older releases have none). `release-meta.mjs write` (release.yml)
 * refuses a release whose notes file has no such row, and a release that needs a restart ("required") without a notes file.
 */
export function checkReleaseMeta(root) {
  const problems = [];
  const notes = notesNewestFirst(join(root, 'docs', 'deploy', 'releases')).filter((n) => n.row !== null);
  if (notes.length === 0) return problems;
  const [subject, older] = notes;
  const { minSfuMediaLevel } = treeLevels(root);
  if (subject.row.restart === null) {
    problems.push(`docs/deploy/releases/${subject.tag}.md: the "Media server (SFU)" row must say exactly one of when-idle or required (it says: ${subject.row.value})`);
    return problems;
  }
  let previous = { tag: BASELINE_TAG, json: null };
  if (older !== undefined) {
    if (older.row.level === null) {
      problems.push(`docs/deploy/releases/${older.tag}.md: the "Media server (SFU)" row must name its media level as "level N" (it says: ${older.row.value})`);
      return problems;
    }
    previous = { tag: older.tag, json: { media_level: older.row.level } };
  }
  const want = sfuRestart({ previous, minSfuMediaLevel });
  if (subject.row.restart !== want) {
    problems.push(`docs/deploy/releases/${subject.tag}.md: the "Media server (SFU)" row says ${subject.row.restart}, but min_sfu_media_level ${minSfuMediaLevel} against ${previous.tag}${previous.json === null ? ' (no release.json: web3.11 = media level 1)' : ` (level ${previous.json.media_level})`} is ${want}`);
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] ?? process.cwd();
  const problems = checkReleaseMeta(root);
  for (const p of problems) console.error(p);
  process.exit(problems.length === 0 ? 0 : 1);
}
