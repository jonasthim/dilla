-- +goose Up
CREATE TABLE bot_interaction_eligibility_revisions (
  community_id BYTEA NOT NULL CHECK(octet_length(community_id)=16),
  user_id BYTEA NOT NULL CHECK(octet_length(user_id)=16),
  revision BIGINT NOT NULL CHECK(revision > 0),
  PRIMARY KEY(community_id,user_id)
);

-- Existing members start with a valid, durable fence. Rows are retained after
-- leave/ban changes so a later rejoin cannot reuse an old eligibility revision.
INSERT INTO bot_interaction_eligibility_revisions(community_id,user_id,revision)
SELECT community_id,user_id,1 FROM members;

-- +goose StatementBegin
CREATE FUNCTION bot_bump_interaction_eligibility(p_community BYTEA,p_user BYTEA) RETURNS VOID AS $$
BEGIN
  INSERT INTO bot_interaction_eligibility_revisions(community_id,user_id,revision)
  VALUES(p_community,p_user,1)
  ON CONFLICT(community_id,user_id) DO UPDATE
  SET revision=bot_interaction_eligibility_revisions.revision+1;
END;
$$ LANGUAGE plpgsql;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION bot_interaction_eligibility_member_changed() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM bot_bump_interaction_eligibility(OLD.community_id,OLD.user_id);
    RETURN OLD;
  END IF;
  PERFORM bot_bump_interaction_eligibility(NEW.community_id,NEW.user_id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
-- +goose StatementEnd
CREATE TRIGGER bot_interaction_eligibility_member_insert AFTER INSERT ON members
FOR EACH ROW EXECUTE FUNCTION bot_interaction_eligibility_member_changed();
CREATE TRIGGER bot_interaction_eligibility_member_delete AFTER DELETE ON members
FOR EACH ROW EXECUTE FUNCTION bot_interaction_eligibility_member_changed();

-- +goose StatementBegin
CREATE FUNCTION bot_interaction_eligibility_ban_changed() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM bot_bump_interaction_eligibility(OLD.community_id,OLD.user_id);
    RETURN OLD;
  END IF;
  PERFORM bot_bump_interaction_eligibility(NEW.community_id,NEW.user_id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
-- +goose StatementEnd
CREATE TRIGGER bot_interaction_eligibility_ban_insert AFTER INSERT ON bans
FOR EACH ROW EXECUTE FUNCTION bot_interaction_eligibility_ban_changed();
CREATE TRIGGER bot_interaction_eligibility_ban_update AFTER UPDATE ON bans
FOR EACH ROW EXECUTE FUNCTION bot_interaction_eligibility_ban_changed();
CREATE TRIGGER bot_interaction_eligibility_ban_delete AFTER DELETE ON bans
FOR EACH ROW EXECUTE FUNCTION bot_interaction_eligibility_ban_changed();

-- +goose StatementBegin
CREATE FUNCTION bot_interaction_eligibility_user_changed() RETURNS TRIGGER AS $$
DECLARE
  old_user BYTEA;
  new_user BYTEA;
  community BYTEA;
BEGIN
  IF TG_OP <> 'INSERT' THEN old_user := OLD.user_id; END IF;
  IF TG_OP <> 'DELETE' THEN new_user := NEW.user_id; END IF;
  IF old_user IS NOT NULL THEN
    FOR community IN SELECT community_id FROM members WHERE user_id=old_user LOOP
      PERFORM bot_bump_interaction_eligibility(community,old_user);
    END LOOP;
  END IF;
  IF new_user IS NOT NULL AND new_user IS DISTINCT FROM old_user THEN
    FOR community IN SELECT community_id FROM members WHERE user_id=new_user LOOP
      PERFORM bot_bump_interaction_eligibility(community,new_user);
    END LOOP;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
-- +goose StatementEnd
CREATE TRIGGER bot_interaction_eligibility_device_insert AFTER INSERT ON devices
FOR EACH ROW EXECUTE FUNCTION bot_interaction_eligibility_user_changed();
CREATE TRIGGER bot_interaction_eligibility_device_update AFTER UPDATE OF dsk_pub,tier,signer_tier,credential_blob,revoked_at,quarantined_at,verified_at,user_id ON devices
FOR EACH ROW WHEN (OLD.dsk_pub IS DISTINCT FROM NEW.dsk_pub OR OLD.tier IS DISTINCT FROM NEW.tier OR OLD.signer_tier IS DISTINCT FROM NEW.signer_tier OR OLD.credential_blob IS DISTINCT FROM NEW.credential_blob OR OLD.revoked_at IS DISTINCT FROM NEW.revoked_at OR OLD.quarantined_at IS DISTINCT FROM NEW.quarantined_at OR OLD.verified_at IS DISTINCT FROM NEW.verified_at OR OLD.user_id IS DISTINCT FROM NEW.user_id)
EXECUTE FUNCTION bot_interaction_eligibility_user_changed();
CREATE TRIGGER bot_interaction_eligibility_device_delete AFTER DELETE ON devices
FOR EACH ROW EXECUTE FUNCTION bot_interaction_eligibility_user_changed();
CREATE TRIGGER bot_interaction_eligibility_device_list_insert AFTER INSERT ON device_lists
FOR EACH ROW EXECUTE FUNCTION bot_interaction_eligibility_user_changed();
CREATE TRIGGER bot_interaction_eligibility_device_list_update AFTER UPDATE ON device_lists
FOR EACH ROW EXECUTE FUNCTION bot_interaction_eligibility_user_changed();
CREATE TRIGGER bot_interaction_eligibility_device_list_delete AFTER DELETE ON device_lists
FOR EACH ROW EXECUTE FUNCTION bot_interaction_eligibility_user_changed();

-- +goose Down
DROP TRIGGER bot_interaction_eligibility_device_list_delete ON device_lists;
DROP TRIGGER bot_interaction_eligibility_device_list_update ON device_lists;
DROP TRIGGER bot_interaction_eligibility_device_list_insert ON device_lists;
DROP TRIGGER bot_interaction_eligibility_device_delete ON devices;
DROP TRIGGER bot_interaction_eligibility_device_update ON devices;
DROP TRIGGER bot_interaction_eligibility_device_insert ON devices;
DROP TRIGGER bot_interaction_eligibility_ban_delete ON bans;
DROP TRIGGER bot_interaction_eligibility_ban_update ON bans;
DROP TRIGGER bot_interaction_eligibility_ban_insert ON bans;
DROP TRIGGER bot_interaction_eligibility_member_delete ON members;
DROP TRIGGER bot_interaction_eligibility_member_insert ON members;
DROP FUNCTION bot_interaction_eligibility_user_changed();
DROP FUNCTION bot_interaction_eligibility_ban_changed();
DROP FUNCTION bot_interaction_eligibility_member_changed();
DROP FUNCTION bot_bump_interaction_eligibility(BYTEA,BYTEA);
DROP TABLE bot_interaction_eligibility_revisions;
