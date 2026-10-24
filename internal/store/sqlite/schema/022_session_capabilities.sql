-- Capability selection belongs to the bearer session. Session deletion removes its selection.
ALTER TABLE sessions ADD COLUMN wire_version INTEGER NOT NULL DEFAULT 0 CHECK (wire_version IN (0, 2, 3));
ALTER TABLE sessions ADD COLUMN e2ee_version INTEGER NOT NULL DEFAULT 0 CHECK (e2ee_version IN (0, 1));
ALTER TABLE sessions ADD COLUMN media_version INTEGER NOT NULL DEFAULT 0 CHECK (media_version IN (0, 1));
