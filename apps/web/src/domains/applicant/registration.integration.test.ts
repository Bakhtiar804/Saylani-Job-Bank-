import { schema } from '@jobbank/db';
import { and, eq } from 'drizzle-orm';
import { beforeAll, expect, it } from 'vitest';
import { POST } from '@/app/api/v1/applicants/staff-register/route';
import { PATCH } from '@/app/api/v1/applicants/[id]/route';
import {
  call,
  signIn,
  signInAdmin,
  signInApplicant,
  randomPhone,
  resetTwoFactor,
} from '@/test/api-client';
import { db } from '@/lib/db';
const path = '/api/v1/applicants/staff-register';
let branch: string;
let other: string;
let staff: Awaited<ReturnType<typeof signIn>>;
const personal = () => ({
  fullName: 'Walk In Applicant',
  fatherName: 'Parent Name',
  cnic: '42' + String(Math.floor(Math.random() * 1e11)).padStart(11, '0'),
  dateOfBirth: '1995-01-01',
  gender: 'MALE',
  consent: true,
});
const create = (body: unknown, jar = staff, key = crypto.randomUUID()) =>
  call(POST, path, { method: 'POST', body, jar, headers: { 'idempotency-key': key } });
beforeAll(async () => {
  branch = (
    await db.select().from(schema.branches).where(eq(schema.branches.code, 'KHI-GULSHAN'))
  )[0]!.id;
  other = (await db.select().from(schema.branches).where(eq(schema.branches.code, 'LHR-JOHAR')))[0]!
    .id;
  staff = await signIn('staff.khi@jobbank.local');
});
it('requires staff authentication and denies applicant/employer roles', async () => {
  expect((await call(POST, path, { method: 'POST', body: personal() })).status).toBe(401);
  expect((await create(personal(), await signInApplicant(randomPhone()))).status).toBe(403);
  expect((await create(personal(), await signIn('employer@jobbank.local'))).status).toBe(403);
});
it('rejects foreign branches and spoofed creator, source, verification and resume fields', async () => {
  expect((await create({ ...personal(), branchId: other })).status).toBe(403);
  for (const field of [
    'registeredByUserId',
    'userId',
    'registrationSource',
    'identityStatus',
    'phoneNumberVerified',
    'resume',
    'cv',
  ])
    expect((await create({ ...personal(), [field]: branch })).status).toBe(422);
});
it('requires consent and idempotency', async () => {
  expect((await create({ ...personal(), consent: false })).status).toBe(422);
  expect((await call(POST, path, { method: 'POST', body: personal(), jar: staff })).status).toBe(
    400,
  );
});
it('creates without email/credentials/resume and retains creator through updates', async () => {
  const result = await create(personal());
  expect(result.status, JSON.stringify(result.body)).toBe(201);
  const [row] = await db
    .select()
    .from(schema.applicants)
    .where(eq(schema.applicants.id, result.body.data.id));
  const [creator] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.email, 'staff.khi@jobbank.local'));
  expect(row).toMatchObject({
    userId: null,
    email: null,
    contactPhone: null,
    registrationSource: 'STAFF_ASSISTED',
    registeredByUserId: creator!.id,
    registrationBranchId: branch,
    branchId: branch,
    identityStatus: 'UNVERIFIED',
    status: 'DRAFT',
  });
  const [audit] = await db
    .select()
    .from(schema.auditLogs)
    .where(
      and(
        eq(schema.auditLogs.entityId, row!.id),
        eq(schema.auditLogs.action, 'applicant.staff_register'),
      ),
    );
  expect(audit).toMatchObject({
    actorUserId: creator!.id,
    metadata: { consent: { accepted: true, version: 'walk-in-registration-v1' } },
  });
  const update = await call(PATCH, '/api/v1/applicants/' + row!.id, {
    method: 'PATCH',
    jar: staff,
    params: { id: row!.id },
    body: { fullName: 'Corrected Name', reason: 'Correct spelling mistake' },
  });
  expect(update.status, JSON.stringify(update.body)).toBe(200);
  expect(
    (await db.select().from(schema.applicants).where(eq(schema.applicants.id, row!.id)))[0]!
      .registeredByUserId,
  ).toBe(creator!.id);
});
it('replays retries, allows shared contacts and rejects duplicate CNIC including races', async () => {
  const body = { ...personal(), contactPhone: '0300 1234567' };
  const key = crypto.randomUUID();
  const first = await create(body, staff, key);
  expect(first.status, JSON.stringify(first.body)).toBe(201);
  const replay = await create(body, staff, key);
  expect(replay.status).toBe(201);
  expect(replay.body.data.id).toBe(first.body.data.id);
  expect((await create({ ...body, fullName: 'Other Name' }, staff, key)).status).toBe(422);
  expect((await create(body)).status).toBe(409);
  expect((await create({ ...body, cnic: personal().cnic })).status).toBe(201);
  const race = personal();
  expect((await Promise.all([create(race), create(race)])).map((r) => r.status).sort()).toEqual([
    201, 409,
  ]);
  expect(
    await db.select().from(schema.applicants).where(eq(schema.applicants.cnic, race.cnic)),
  ).toHaveLength(1);
});
it('rolls back applicant creation when related section validation fails', async () => {
  const body = { ...personal(), education: { items: [{ levelCode: 'MISSING_EDUCATION_CODE' }] } };
  expect((await create(body)).status).toBe(422);
  expect(
    await db.select().from(schema.applicants).where(eq(schema.applicants.cnic, body.cnic)),
  ).toHaveLength(0);
});
it('requires admin 2FA and accepts authorized admin after enrolment', async () => {
  await resetTwoFactor('branchadmin.khi@jobbank.local');
  expect((await create(personal(), await signIn('branchadmin.khi@jobbank.local'))).status).toBe(
    403,
  );
  expect(
    (await create(personal(), await signInAdmin('branchadmin.khi@jobbank.local'))).status,
  ).toBe(201);
});

it('saves manual related sections atomically without contacting the matching service', async () => {
  const { vi } = await import('vitest');
  const [level] = await db
    .select()
    .from(schema.masterData)
    .where(
      and(eq(schema.masterData.type, 'EDUCATION_LEVEL'), eq(schema.masterData.isActive, true)),
    );
  const body = {
    ...personal(),
    location: {
      cityCode: 'KARACHI',
      addressLine: 'Manual home address',
      location: { lat: 24.9256, lng: 67.0899 },
    },
    education: { items: [{ levelCode: level!.code, institution: 'Manual School' }] },
    experience: { hasNoExperience: true, items: [] },
    skills: { items: [{ skillCode: 'WALK_IN_MANUAL_SKILL', level: 'BEGINNER', years: 0 }] },
  };
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(new Error('Matching is unavailable'));
  let result;
  try {
    result = await create(body);
    expect(result.status, JSON.stringify(result.body)).toBe(201);
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    fetch.mockRestore();
  }
  const id = result!.body.data.id;
  expect(
    await db
      .select()
      .from(schema.applicantEducation)
      .where(eq(schema.applicantEducation.applicantId, id)),
  ).toHaveLength(1);
  expect(
    await db
      .select()
      .from(schema.applicantAddresses)
      .where(eq(schema.applicantAddresses.applicantId, id)),
  ).toHaveLength(1);
  expect(
    await db
      .select()
      .from(schema.applicantSkills)
      .where(eq(schema.applicantSkills.applicantId, id)),
  ).toHaveLength(1);
});
it('makes an account-less draft searchable with its unverified shared contact', async () => {
  const { GET } = await import('@/app/api/v1/applicants/route');
  const body = { ...personal(), contactPhone: '03001234567' };
  const result = await create(body);
  expect(result.status).toBe(201);
  const list = await call(GET, '/api/v1/applicants?q=' + body.cnic, { jar: staff });
  expect(list.status, JSON.stringify(list.body)).toBe(200);
  expect(list.body.data.some((row: { id: string }) => row.id === result.body.data.id)).toBe(true);
});
it('keeps existing personal validation and rejects malformed contacts', async () => {
  expect((await create({ ...personal(), dateOfBirth: '2020-01-01' })).status).toBe(422);
  expect((await create({ ...personal(), contactPhone: '030012345678999' })).status).toBe(422);
});

it('persists walk-in work history and desired job categories without an applicant account', async () => {
  const [category] = await db
    .select()
    .from(schema.masterData)
    .where(and(eq(schema.masterData.type, 'JOB_CATEGORY'), eq(schema.masterData.isActive, true)));
  expect(category).toBeTruthy();
  const result = await create({
    ...personal(),
    experience: {
      hasNoExperience: false,
      items: [
        {
          employerName: 'Local Shop',
          jobTitle: 'Shop Assistant',
          categoryCode: category!.code,
          startMonth: '2020-01',
          endMonth: null,
          isCurrent: true,
          description: 'Customer service',
        },
      ],
    },
    preferences: { categoryCodes: [category!.code], shifts: [], jobTypes: [] },
  });
  expect(result.status, JSON.stringify(result.body)).toBe(201);
  const id = result.body.data.id;
  const [work] = await db
    .select()
    .from(schema.applicantExperience)
    .where(eq(schema.applicantExperience.applicantId, id));
  const [preference] = await db
    .select()
    .from(schema.applicantPreferences)
    .where(eq(schema.applicantPreferences.applicantId, id));
  const [applicant] = await db.select().from(schema.applicants).where(eq(schema.applicants.id, id));
  expect(work).toMatchObject({
    jobTitle: 'Shop Assistant',
    employerName: 'Local Shop',
    categoryCode: category!.code,
    isCurrent: true,
  });
  expect(preference!.categoryCodes).toEqual([category!.code]);
  expect(applicant).toMatchObject({
    userId: null,
    email: null,
    registrationSource: 'STAFF_ASSISTED',
    identityStatus: 'UNVERIFIED',
  });
});
