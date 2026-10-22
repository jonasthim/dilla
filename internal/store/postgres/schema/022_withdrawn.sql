-- 022_withdrawn.sql: the withdrawal of an absence Remove (UP6b, R-UP12), migration
-- 00024_withdrawn.sql. protocol/02 invariant 6, "Withdrawal".
--
-- withdrawable is 1 only for an instance Remove issued because a device stayed out of its call's
-- room (the room sweep) or left it: never for a revocation, a kick or ban, an eviction, a barred
-- device's cut or a member's own proposal. Every re-issue of the row carries it over.
-- withdrawn_at and withdrawn_seq mark a Remove the resuming device's own call start withdrew, and
-- the seq of the kind-3 handshake row that says so. The row stays (marked) so that a commit that
-- still applies it is refused 409 `withdrawn`; it is excluded from every listing and pruned with
-- its epoch.
ALTER TABLE mls_pending_proposals ADD COLUMN withdrawable SMALLINT NOT NULL DEFAULT 0 CHECK (withdrawable IN (0, 1));
ALTER TABLE mls_pending_proposals ADD COLUMN withdrawn_at BIGINT;
ALTER TABLE mls_pending_proposals ADD COLUMN withdrawn_seq BIGINT;
-- mls_handshakes gains kind 3 (withdrawn).
ALTER TABLE mls_handshakes DROP CONSTRAINT mls_handshakes_kind_check;
ALTER TABLE mls_handshakes ADD CONSTRAINT mls_handshakes_kind_check CHECK (kind IN (0, 1, 2, 3));
