-- Nullable provenance preserves unknown history. No data backfill or auth changes.
ALTER TABLE applicants
  ADD COLUMN registered_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN registration_branch_id uuid REFERENCES branches(id) ON DELETE RESTRICT,
  ADD COLUMN registration_source text,
  ALTER COLUMN user_id DROP NOT NULL;
--> statement-breakpoint
-- Only future inserts default to SELF; existing rows remain NULL.
ALTER TABLE applicants ALTER COLUMN registration_source SET DEFAULT 'SELF';
--> statement-breakpoint
-- IS TRUE prevents PostgreSQL CHECK's NULL semantics from accepting partial attribution.
ALTER TABLE applicants ADD CONSTRAINT applicants_registration_valid CHECK (((
  registration_source IS NULL AND registered_by_user_id IS NULL
  AND registration_branch_id IS NULL AND user_id IS NOT NULL
) OR (
  registration_source = 'SELF' AND user_id IS NOT NULL AND registered_by_user_id IS NULL
) OR (
  registration_source = 'STAFF_ASSISTED' AND registered_by_user_id IS NOT NULL
  AND registration_branch_id IS NOT NULL
)) IS TRUE);
--> statement-breakpoint
CREATE INDEX applicants_registration_branch_created_idx ON applicants (registration_branch_id, created_at);
--> statement-breakpoint
CREATE INDEX applicants_registered_by_idx ON applicants (registered_by_user_id);
--> statement-breakpoint
CREATE FUNCTION jobbank_preserve_applicant_registration() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.registered_by_user_id IS DISTINCT FROM OLD.registered_by_user_id
     OR NEW.registration_branch_id IS DISTINCT FROM OLD.registration_branch_id
     OR NEW.registration_source IS DISTINCT FROM OLD.registration_source
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Applicant registration attribution is immutable' USING ERRCODE = 'JB001';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER applicants_preserve_registration BEFORE UPDATE ON applicants
FOR EACH ROW EXECUTE FUNCTION jobbank_preserve_applicant_registration();
-- Existing table-level app_rw grants cover these columns. No additional privileges,
-- role assignments, or SECURITY DEFINER functions are needed.
