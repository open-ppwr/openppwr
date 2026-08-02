ALTER TABLE evidence_files ADD COLUMN retention_status text NOT NULL DEFAULT 'retained'
  CHECK (retention_status IN ('retained','deleting','deleted'));
ALTER TABLE evidence_files ADD COLUMN deleted_at timestamptz;

