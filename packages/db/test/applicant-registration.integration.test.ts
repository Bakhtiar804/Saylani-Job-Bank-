import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDb } from '../src/client';
import { runMigrations } from '../src/scripts/migrate';
import { testAppUrl, testMigratorUrl } from './helpers';
const app = createDb(testAppUrl, { max: 1 });
let creator: string;
let branch: string;
let id: string;
const cnic = () => '35' + String(Math.floor(Math.random() * 1e11)).padStart(11, '0');
beforeAll(async () => {
  await runMigrations(testMigratorUrl);
  [{ id: creator }] = await app.client<
    [{ id: string }]
  >`INSERT INTO users (name, email) VALUES ('Probe', ${crypto.randomUUID() + '@probe.test'}) RETURNING id`;
  [{ id: branch }] = await app.client<
    [{ id: string }]
  >`INSERT INTO branches (code, name, city) VALUES (${'WI-' + crypto.randomUUID().slice(0, 8).toUpperCase()}, 'Probe', 'Karachi') RETURNING id`;
});
afterAll(async () => {
  await app.client.end();
});
it('supports unverified assisted drafts without fabricated contacts', async () => {
  const [row] =
    await app.client`INSERT INTO applicants (full_name, father_name, cnic, date_of_birth, gender, registered_by_user_id, registration_branch_id, registration_source)
    VALUES ('Walk In', 'Parent Name', ${cnic()}, '1990-01-01', 'MALE', ${creator}, ${branch}, 'STAFF_ASSISTED') RETURNING *`;
  id = row!.id;
  expect(row).toMatchObject({
    user_id: null,
    email: null,
    identity_status: 'UNVERIFIED',
    status: 'DRAFT',
  });
  expect(Number.isFinite(new Date(row!.created_at).getTime())).toBe(true);
});
it('rejects missing, partial or invalid provenance', async () => {
  for (const source of [null, 'SELF', 'STAFF_ASSISTED', 'INVALID']) {
    await expect(app.client`INSERT INTO applicants (full_name, father_name, cnic, date_of_birth, gender, registration_source)
      VALUES ('Walk In', 'Parent Name', ${cnic()}, '1990-01-01', 'MALE', ${source})`).rejects.toMatchObject(
      { constraint_name: 'applicants_registration_valid' },
    );
  }
});
it('preserves explicitly unknown legacy attribution', async () => {
  const [row] =
    await app.client`INSERT INTO applicants (user_id, full_name, father_name, cnic, date_of_birth, gender, registration_source)
    VALUES (${creator}, 'Legacy Probe', 'Parent Name', ${cnic()}, '1990-01-01', 'MALE', NULL) RETURNING *`;
  expect(row).toMatchObject({
    registration_source: null,
    registered_by_user_id: null,
    registration_branch_id: null,
  });
  await expect(
    app.client`UPDATE applicants SET registration_source = 'SELF' WHERE id = ${row!.id}`,
  ).rejects.toMatchObject({ code: 'JB001' });
});
it('protects original attribution while allowing normal edits', async () => {
  for (const field of ['registered_by_user_id', 'registration_branch_id', 'registration_source']) {
    await expect(
      app.client`UPDATE applicants SET ${app.client(field)} = NULL WHERE id = ${id}`,
    ).rejects.toMatchObject({ code: 'JB001' });
  }
  await expect(
    app.client`UPDATE applicants SET created_at = now() + interval '1 day' WHERE id = ${id}`,
  ).rejects.toMatchObject({ code: 'JB001' });
  await app.client`UPDATE applicants SET full_name = 'Corrected Name', branch_id = ${branch} WHERE id = ${id}`;
  const [row] =
    await app.client`SELECT registered_by_user_id, registration_branch_id FROM applicants WHERE id = ${id}`;
  expect(row).toEqual({ registered_by_user_id: creator, registration_branch_id: branch });
});

it('upgrades historical rows without backfill and defaults only future self registrations', async () => {
  const { readFile } = await import('node:fs/promises');
  const owner = createDb(testMigratorUrl, { max: 1 });
  const migration = await readFile(
    new URL('../migrations/0023_applicant_registration.sql', import.meta.url),
    'utf8',
  );
  const rollback = new Error('rollback isolated upgrade probe');
  try {
    await expect(
      owner.client.begin(async (tx) => {
        const namespace = 'registration_probe_' + crypto.randomUUID().replaceAll('-', '');
        await tx`CREATE SCHEMA ${tx(namespace)}`;
        await tx`SET LOCAL search_path TO ${tx(namespace)}`;
        await tx.unsafe(
          'CREATE TABLE users (id uuid PRIMARY KEY); CREATE TABLE branches (id uuid PRIMARY KEY); CREATE TABLE applicants (id uuid PRIMARY KEY, user_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now())',
        );
        const user = crypto.randomUUID();
        const legacy = crypto.randomUUID();
        await tx`INSERT INTO users VALUES (${user})`;
        await tx`INSERT INTO applicants (id, user_id) VALUES (${legacy}, ${user})`;
        for (const statement of migration.split('--> statement-breakpoint'))
          await tx.unsafe(statement);
        const [old] = await tx`SELECT registration_source FROM applicants WHERE id = ${legacy}`;
        expect(old!.registration_source).toBeNull();
        const [fresh] =
          await tx`INSERT INTO applicants (id, user_id) VALUES (${crypto.randomUUID()}, ${user}) RETURNING registration_source`;
        expect(fresh!.registration_source).toBe('SELF');
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  } finally {
    await owner.client.end();
  }
});

it('stores optional contacts under runtime grants without making shared phones unique', async () => {
  await app.client`UPDATE applicants SET contact_phone = '+923001234567' WHERE id = ${id}`;
  await expect(
    app.client`UPDATE applicants SET contact_phone = 'invalid' WHERE id = ${id}`,
  ).rejects.toMatchObject({ constraint_name: 'applicants_contact_phone_format' });
  const [row] = await app.client`SELECT contact_phone FROM applicants WHERE id = ${id}`;
  expect(row!.contact_phone).toBe('+923001234567');
  const [indexes] =
    await app.client`SELECT count(*)::int AS n FROM pg_indexes WHERE tablename = 'applicants' AND indexdef LIKE '%UNIQUE%contact_phone%'`;
  expect(indexes!.n).toBe(0);
});
