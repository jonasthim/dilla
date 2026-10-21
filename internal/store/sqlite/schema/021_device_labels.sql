-- 021_device_labels.sql: the owner's own name for a device (EOD E7), migration
-- 00023_device_labels.sql. NULL is no name; the client then shows the first eight characters
-- of the device id. The label is not part of the signed device list: the server stores it
-- readable, like a display name, and could change it.
ALTER TABLE devices ADD COLUMN label TEXT CHECK (label IS NULL OR (length(label) BETWEEN 1 AND 64));
