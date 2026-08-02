DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openppwr_app') THEN
    CREATE ROLE openppwr_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION openppwr_current_tenant() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('openppwr.tenant_id', true), '')::uuid
$$;

CREATE TABLE tenants (
  id uuid PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  disclaimer text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE identities (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL,
  display_name text NOT NULL,
  role text NOT NULL CHECK (role IN ('tenant_admin','compliance_manager','packaging_editor','evidence_contributor','evidence_reviewer','read_only_auditor','supplier_user','service_account','worker')),
  supplier_id text,
  token_hash text NOT NULL UNIQUE,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE import_runs (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL,
  idempotency_key text NOT NULL,
  checksum text NOT NULL,
  schema_version text NOT NULL,
  status text NOT NULL CHECK (status IN ('accepted','rejected')),
  total_rows integer NOT NULL,
  accepted_rows integer NOT NULL,
  rejected_rows integer NOT NULL,
  errors jsonb NOT NULL DEFAULT '[]',
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE TABLE import_row_results (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  import_id uuid NOT NULL,
  row_number integer NOT NULL,
  status text NOT NULL CHECK (status IN ('accepted','rejected')),
  errors jsonb NOT NULL DEFAULT '[]',
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, import_id) REFERENCES import_runs(tenant_id, id)
);

CREATE TABLE suppliers (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id text NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE materials (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id text NOT NULL,
  name text NOT NULL,
  family text NOT NULL,
  recycled_content_pct numeric(7,3),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE components (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id text NOT NULL,
  name text NOT NULL,
  material_id text NOT NULL,
  supplier_id text NOT NULL,
  mass_g numeric(14,6) NOT NULL CHECK (mass_g > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, material_id) REFERENCES materials(tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers(tenant_id, id)
);

CREATE TABLE packaging (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id text NOT NULL,
  name text NOT NULL,
  packaging_type text NOT NULL CHECK (packaging_type IN ('sales','grouped','transport','ecommerce','reusable')),
  country text NOT NULL,
  supplier_id text NOT NULL,
  recycled_content_pct numeric(7,3),
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers(tenant_id, id)
);

CREATE TABLE boms (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id text NOT NULL,
  packaging_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL CHECK (status IN ('draft','approved','superseded')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, packaging_id) REFERENCES packaging(tenant_id, id),
  UNIQUE (tenant_id, packaging_id, version)
);

CREATE TABLE bom_lines (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL,
  bom_id text NOT NULL,
  component_id text NOT NULL,
  quantity numeric(14,6) NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, bom_id) REFERENCES boms(tenant_id, id),
  FOREIGN KEY (tenant_id, component_id) REFERENCES components(tenant_id, id),
  UNIQUE (tenant_id, bom_id, component_id)
);

CREATE TABLE rule_versions (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  rule_id text NOT NULL,
  version text NOT NULL,
  source_reference text NOT NULL,
  publication_date date NOT NULL,
  effective_from date NOT NULL,
  effective_to date,
  lifecycle_status text NOT NULL CHECK (lifecycle_status IN ('draft','approved','withdrawn')),
  reviewer_status text NOT NULL,
  required_inputs jsonb NOT NULL,
  required_evidence jsonb NOT NULL,
  applicability jsonb NOT NULL,
  checks jsonb NOT NULL,
  explanation_keys jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, rule_id, version)
);

CREATE TABLE evidence_requirements (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL,
  packaging_id text NOT NULL,
  supplier_id text NOT NULL,
  evidence_type text NOT NULL,
  rule_id text NOT NULL,
  rule_version text NOT NULL,
  status text NOT NULL DEFAULT 'required',
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, packaging_id) REFERENCES packaging(tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers(tenant_id, id),
  FOREIGN KEY (tenant_id, rule_id, rule_version) REFERENCES rule_versions(tenant_id, rule_id, version),
  UNIQUE (tenant_id, packaging_id, evidence_type, rule_id, rule_version)
);

CREATE TABLE evidence_files (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL,
  requirement_id uuid,
  supplier_id text NOT NULL,
  evidence_type text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  original_filename text NOT NULL,
  normalized_filename text NOT NULL,
  declared_mime text NOT NULL,
  detected_mime text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 10485760),
  sha256 text NOT NULL,
  storage_key text NOT NULL,
  scan_status text NOT NULL CHECK (scan_status IN ('pending','clean','infected','error','timeout')),
  review_status text NOT NULL CHECK (review_status IN ('pending','accepted','rejected')) DEFAULT 'pending',
  expires_at timestamptz,
  uploaded_by uuid NOT NULL,
  reviewed_by uuid,
  reviewed_at timestamptz,
  rejection_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, requirement_id) REFERENCES evidence_requirements(tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers(tenant_id, id),
  UNIQUE (tenant_id, storage_key)
);

CREATE TABLE scan_jobs (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL,
  evidence_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','running','completed','failed','dead')) DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, evidence_id) REFERENCES evidence_files(tenant_id, id),
  UNIQUE (tenant_id, evidence_id)
);

CREATE TABLE assessments (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL,
  packaging_id text NOT NULL,
  rule_id text NOT NULL,
  rule_version text NOT NULL,
  supersedes_id uuid,
  status text NOT NULL CHECK (status IN ('completed','superseded')) DEFAULT 'completed',
  input_snapshot jsonb NOT NULL,
  evidence_snapshot jsonb NOT NULL,
  evaluated_by uuid NOT NULL,
  evaluated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, packaging_id) REFERENCES packaging(tenant_id, id),
  FOREIGN KEY (tenant_id, rule_id, rule_version) REFERENCES rule_versions(tenant_id, rule_id, version),
  FOREIGN KEY (tenant_id, supersedes_id) REFERENCES assessments(tenant_id, id)
);

CREATE TABLE assessment_results (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL,
  assessment_id uuid NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('PASS','FAIL','UNKNOWN','NOT_APPLICABLE')),
  explanation jsonb NOT NULL,
  missing_inputs jsonb NOT NULL,
  missing_evidence jsonb NOT NULL,
  evidence_ids jsonb NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, assessment_id) REFERENCES assessments(tenant_id, id),
  UNIQUE (tenant_id, assessment_id)
);

CREATE TABLE gaps (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id text NOT NULL,
  packaging_id text NOT NULL,
  rule_id text NOT NULL,
  rule_version text NOT NULL,
  deduplication_key text NOT NULL,
  current_assessment_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('open','assigned','remediated','closed','reopened')),
  owner_id uuid,
  remediation_notes text,
  remediation_evidence_ids jsonb NOT NULL DEFAULT '[]',
  history jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, packaging_id) REFERENCES packaging(tenant_id, id),
  FOREIGN KEY (tenant_id, current_assessment_id) REFERENCES assessments(tenant_id, id),
  UNIQUE (tenant_id, packaging_id, rule_id, deduplication_key)
);

CREATE TABLE review_snapshots (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL,
  locale text NOT NULL CHECK (locale IN ('en','pl','de')),
  generator_version text NOT NULL,
  frozen_at timestamptz NOT NULL,
  frozen_by uuid NOT NULL,
  snapshot jsonb NOT NULL,
  snapshot_sha256 text NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE dossier_artifacts (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  artifact_type text NOT NULL CHECK (artifact_type IN ('json','pdf','zip','manifest')),
  storage_key text NOT NULL,
  sha256 text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, snapshot_id) REFERENCES review_snapshots(tenant_id, id),
  UNIQUE (tenant_id, snapshot_id, artifact_type)
);

CREATE TABLE audit_events (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  sequence bigserial NOT NULL,
  event_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  previous_hash text NOT NULL,
  event_hash text NOT NULL,
  PRIMARY KEY (tenant_id, event_id),
  UNIQUE (tenant_id, sequence),
  UNIQUE (tenant_id, event_hash)
);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'identities','import_runs','import_row_results','suppliers','materials','components','packaging','boms','bom_lines',
    'rule_versions','evidence_requirements','evidence_files','scan_jobs','assessments','assessment_results','gaps',
    'review_snapshots','dossier_artifacts','audit_events'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = openppwr_current_tenant()) WITH CHECK (tenant_id = openppwr_current_tenant())', table_name);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION authenticate_openppwr_token(p_token_hash text)
RETURNS TABLE (tenant_id uuid, actor_id uuid, actor_role text, supplier_id text)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp AS $$
  SELECT i.tenant_id, i.id, i.role, i.supplier_id
  FROM identities i
  WHERE i.token_hash = p_token_hash AND i.active = true
$$;
REVOKE ALL ON FUNCTION authenticate_openppwr_token(text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION reject_audit_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit events are append-only'; END $$;
CREATE TRIGGER audit_events_immutable BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();

GRANT USAGE ON SCHEMA public TO openppwr_app;
GRANT SELECT, INSERT ON tenants TO openppwr_app;
GRANT SELECT ON identities, import_runs, import_row_results, suppliers, materials, components, packaging, boms, bom_lines,
  rule_versions, evidence_requirements, evidence_files, scan_jobs, assessments, assessment_results, gaps,
  review_snapshots, dossier_artifacts, audit_events TO openppwr_app;
GRANT INSERT ON identities, import_runs, import_row_results, suppliers, materials, components, packaging, boms, bom_lines,
  rule_versions, evidence_requirements, evidence_files, scan_jobs, assessments, assessment_results, gaps,
  review_snapshots, dossier_artifacts, audit_events TO openppwr_app;
GRANT UPDATE ON identities, packaging, evidence_requirements, evidence_files, scan_jobs, assessments, gaps TO openppwr_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO openppwr_app;
GRANT EXECUTE ON FUNCTION authenticate_openppwr_token(text) TO openppwr_app;
