-- Contact information is not a login identity. Shared numbers are deliberately non-unique.
ALTER TABLE applicants ADD COLUMN contact_phone text;
--> statement-breakpoint
ALTER TABLE applicants ADD CONSTRAINT applicants_contact_phone_format
  CHECK (contact_phone IS NULL OR contact_phone ~ '^[+]923[0-9]{9}$');
