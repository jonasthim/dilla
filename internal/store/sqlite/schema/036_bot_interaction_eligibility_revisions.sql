CREATE TABLE bot_interaction_eligibility_revisions (
  community_id BLOB NOT NULL CHECK(length(community_id)=16),
  user_id BLOB NOT NULL CHECK(length(user_id)=16),
  revision INTEGER NOT NULL CHECK(revision > 0),
  PRIMARY KEY(community_id,user_id)
) STRICT;

-- Existing members start with a valid, durable fence. Rows are retained after
-- leave/ban changes so a later rejoin cannot reuse an old eligibility revision.
INSERT INTO bot_interaction_eligibility_revisions(community_id,user_id,revision)
SELECT community_id,user_id,1 FROM members;

-- +goose StatementBegin
CREATE TRIGGER bot_interaction_eligibility_member_insert AFTER INSERT ON members BEGIN
  INSERT INTO bot_interaction_eligibility_revisions(community_id,user_id,revision)
  VALUES(NEW.community_id,NEW.user_id,1)
  ON CONFLICT(community_id,user_id) DO UPDATE SET revision=revision+1;
END;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE TRIGGER bot_interaction_eligibility_member_delete AFTER DELETE ON members BEGIN
  INSERT INTO bot_interaction_eligibility_revisions(community_id,user_id,revision)
  VALUES(OLD.community_id,OLD.user_id,1)
  ON CONFLICT(community_id,user_id) DO UPDATE SET revision=revision+1;
END;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TRIGGER bot_interaction_eligibility_ban_insert AFTER INSERT ON bans BEGIN
  INSERT INTO bot_interaction_eligibility_revisions(community_id,user_id,revision)
  VALUES(NEW.community_id,NEW.user_id,1)
  ON CONFLICT(community_id,user_id) DO UPDATE SET revision=revision+1;
END;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE TRIGGER bot_interaction_eligibility_ban_update AFTER UPDATE ON bans BEGIN
  INSERT INTO bot_interaction_eligibility_revisions(community_id,user_id,revision)
  VALUES(NEW.community_id,NEW.user_id,1)
  ON CONFLICT(community_id,user_id) DO UPDATE SET revision=revision+1;
END;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE TRIGGER bot_interaction_eligibility_ban_delete AFTER DELETE ON bans BEGIN
  INSERT INTO bot_interaction_eligibility_revisions(community_id,user_id,revision)
  VALUES(OLD.community_id,OLD.user_id,1)
  ON CONFLICT(community_id,user_id) DO UPDATE SET revision=revision+1;
END;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TRIGGER bot_interaction_eligibility_device_insert AFTER INSERT ON devices BEGIN
  INSERT INTO bot_interaction_eligibility_revisions(community_id,user_id,revision)
  SELECT community_id,NEW.user_id,1 FROM members WHERE user_id=NEW.user_id
  ON CONFLICT(community_id,user_id) DO UPDATE SET revision=revision+1;
END;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE TRIGGER bot_interaction_eligibility_device_update AFTER UPDATE OF dsk_pub,tier,signer_tier,credential_blob,revoked_at,quarantined_at,verified_at ON devices
WHEN OLD.dsk_pub IS NOT NEW.dsk_pub OR OLD.tier IS NOT NEW.tier OR OLD.signer_tier IS NOT NEW.signer_tier OR OLD.credential_blob IS NOT NEW.credential_blob OR OLD.revoked_at IS NOT NEW.revoked_at OR OLD.quarantined_at IS NOT NEW.quarantined_at OR OLD.verified_at IS NOT NEW.verified_at BEGIN
  INSERT INTO bot_interaction_eligibility_revisions(community_id,user_id,revision)
  SELECT community_id,NEW.user_id,1 FROM members WHERE user_id=NEW.user_id
  ON CONFLICT(community_id,user_id) DO UPDATE SET revision=revision+1;
END;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE TRIGGER bot_interaction_eligibility_device_delete AFTER DELETE ON devices BEGIN
  INSERT INTO bot_interaction_eligibility_revisions(community_id,user_id,revision)
  SELECT community_id,OLD.user_id,1 FROM members WHERE user_id=OLD.user_id
  ON CONFLICT(community_id,user_id) DO UPDATE SET revision=revision+1;
END;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TRIGGER bot_interaction_eligibility_device_list_insert AFTER INSERT ON device_lists BEGIN
  INSERT INTO bot_interaction_eligibility_revisions(community_id,user_id,revision)
  SELECT community_id,NEW.user_id,1 FROM members WHERE user_id=NEW.user_id
  ON CONFLICT(community_id,user_id) DO UPDATE SET revision=revision+1;
END;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE TRIGGER bot_interaction_eligibility_device_list_update AFTER UPDATE ON device_lists BEGIN
  INSERT INTO bot_interaction_eligibility_revisions(community_id,user_id,revision)
  SELECT community_id,NEW.user_id,1 FROM members WHERE user_id=NEW.user_id
  ON CONFLICT(community_id,user_id) DO UPDATE SET revision=revision+1;
END;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE TRIGGER bot_interaction_eligibility_device_list_delete AFTER DELETE ON device_lists BEGIN
  INSERT INTO bot_interaction_eligibility_revisions(community_id,user_id,revision)
  SELECT community_id,OLD.user_id,1 FROM members WHERE user_id=OLD.user_id
  ON CONFLICT(community_id,user_id) DO UPDATE SET revision=revision+1;
END;
-- +goose StatementEnd
