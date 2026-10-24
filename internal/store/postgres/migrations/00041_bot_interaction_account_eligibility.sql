-- +goose Up
-- Account disable and tombstone change whether a human can hold an admission.
-- +goose StatementBegin
CREATE FUNCTION bot_interaction_eligibility_account_changed() RETURNS TRIGGER AS $$
DECLARE community BYTEA;
BEGIN
  FOR community IN SELECT community_id FROM members WHERE user_id=NEW.id LOOP
    PERFORM bot_bump_interaction_eligibility(community,NEW.id);
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
-- +goose StatementEnd
CREATE TRIGGER bot_interaction_eligibility_account_update
AFTER UPDATE OF disabled_at,deleted_at ON users
FOR EACH ROW WHEN (OLD.disabled_at IS DISTINCT FROM NEW.disabled_at OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
EXECUTE FUNCTION bot_interaction_eligibility_account_changed();

-- +goose Down
DROP TRIGGER bot_interaction_eligibility_account_update ON users;
DROP FUNCTION bot_interaction_eligibility_account_changed();
