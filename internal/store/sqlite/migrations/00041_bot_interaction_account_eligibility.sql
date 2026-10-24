-- +goose Up
-- Account disable and tombstone change whether a human can hold an admission.
-- Bump every community fence only when those eligibility fields actually change.
-- +goose StatementBegin
CREATE TRIGGER bot_interaction_eligibility_account_update
AFTER UPDATE OF disabled_at,deleted_at ON users
WHEN OLD.disabled_at IS NOT NEW.disabled_at OR OLD.deleted_at IS NOT NEW.deleted_at
BEGIN
  INSERT INTO bot_interaction_eligibility_revisions(community_id,user_id,revision)
  SELECT community_id,NEW.id,1 FROM members WHERE user_id=NEW.id
  ON CONFLICT(community_id,user_id) DO UPDATE SET revision=revision+1;
END;
-- +goose StatementEnd

-- +goose Down
DROP TRIGGER bot_interaction_eligibility_account_update;
