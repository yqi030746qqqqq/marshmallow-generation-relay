ALTER TABLE jobs ADD COLUMN error_envelope TEXT;

UPDATE jobs
SET error_json = NULL
WHERE error_json IS NOT NULL;
