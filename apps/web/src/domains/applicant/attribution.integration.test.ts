import { schema } from '@jobbank/db';
import { eq } from 'drizzle-orm';
import { beforeAll, expect, it } from 'vitest';
import { GET } from '@/app/api/v1/applicants/route';
import { GET as detail, PATCH } from '@/app/api/v1/applicants/[id]/route';
import { POST } from '@/app/api/v1/applicants/staff-register/route';
import { listApplicantCreators } from '@/domains/applicant';
import { loadActor } from '@/domains/auth';
import { call, signIn, owner } from '@/test/api-client';
import { db } from '@/lib/db';
let staff: Awaited<ReturnType<typeof signIn>>;
let creator: string;
let foreignCreator: string;
let branch: string;
let otherBranch: string;
let foreignId: string;
const prefix = 'Attribution ' + crypto.randomUUID().slice(0, 8).replace(/[0-9]/g, 'a');
const ids: string[] = [];
let legacy: string;
const personal = () => ({
  fullName: prefix,
  fatherName: 'Parent Name',
  cnic: '42' + String(Math.floor(Math.random() * 1e11)).padStart(11, '0'),
  dateOfBirth: '1995-01-01',
  gender: 'MALE',
  consent: true,
});
async function add(jar = staff) {
  const result = await call(POST, '/api/v1/applicants/staff-register', {
    method: 'POST',
    jar,
    body: personal(),
    headers: { 'idempotency-key': crypto.randomUUID() },
  });
  expect(result.status, JSON.stringify(result.body)).toBe(201);
  return result.body.data.id as string;
}
const list = (query: string, jar = staff) => call(GET, '/api/v1/applicants?' + query, { jar });
beforeAll(async () => {
  staff = await signIn('staff.khi@jobbank.local');
  creator = (
    await db.select().from(schema.users).where(eq(schema.users.email, 'staff.khi@jobbank.local'))
  )[0]!.id;
  foreignCreator = (
    await db.select().from(schema.users).where(eq(schema.users.email, 'staff.lhr@jobbank.local'))
  )[0]!.id;
  branch = (
    await db.select().from(schema.branches).where(eq(schema.branches.code, 'KHI-GULSHAN'))
  )[0]!.id;
  otherBranch = (
    await db.select().from(schema.branches).where(eq(schema.branches.code, 'LHR-JOHAR'))
  )[0]!.id;
  for (let i = 0; i < 3; i++) ids.push(await add());
  foreignId = await add(await signIn('staff.lhr@jobbank.local'));
  // A home pin in the viewer city must not expose a record held outside their branch-city scope.
  await db.insert(schema.applicantAddresses).values({
    applicantId: foreignId,
    addressLine: 'Scope test address',
    cityCode: 'KARACHI',
    location: { lat: 24.9256, lng: 67.0899 },
  });
  // Explicit NULL represents unknown history; no attribution is guessed or backfilled.
  const [user] = await db
    .insert(schema.users)
    .values({ name: 'Historical Test', email: crypto.randomUUID() + '@probe.test' })
    .returning();
  const p = personal();
  const [old] = await db
    .insert(schema.applicants)
    .values({
      userId: user!.id,
      branchId: branch,
      fullName: prefix + ' Historical',
      fatherName: p.fatherName,
      cnic: p.cnic,
      dateOfBirth: p.dateOfBirth,
      gender: 'MALE',
      registrationSource: null,
    })
    .returning();
  legacy = old!.id;
});
it('returns original attribution, reference, creation date and current status in list/detail', async () => {
  const result = await list('q=' + ids[0]);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  expect(result.body.data).toHaveLength(1);
  expect(result.body.data[0]).toMatchObject({
    id: ids[0],
    registrationSource: 'STAFF_ASSISTED',
    registeredByName: 'Sana Staff (Karachi)',
    registrationBranchName: 'Karachi — Gulshan-e-Iqbal',
    status: 'DRAFT',
  });
  const d = await call(detail, '/api/v1/applicants/' + ids[0], {
    jar: staff,
    params: { id: ids[0]! },
  });
  expect(d.status).toBe(200);
  expect(d.body.data.registeredByName).toBe('Sana Staff (Karachi)');
  expect(d.body.data.createdAt).toBe(result.body.data[0].createdAt);
});
it('combines search, source, creator, branch, local dates and stable pagination', async () => {
  const [row] = await db.select().from(schema.applicants).where(eq(schema.applicants.id, ids[0]!));
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(row!.createdAt);
  const query = new URLSearchParams({
    q: prefix,
    creatorId: creator,
    branchId: branch,
    registrationSource: 'STAFF_ASSISTED',
    registeredFrom: date,
    registeredTo: date,
    pageSize: '2',
    sort: 'createdAt:asc',
  });
  const first = await list(query.toString());
  expect(first.status, JSON.stringify(first.body)).toBe(200);
  expect(first.body.meta).toMatchObject({ total: 3, pageCount: 2, page: 1 });
  query.set('page', '2');
  const second = await list(query.toString());
  expect(second.body.data).toHaveLength(1);
  expect(new Set([...first.body.data, ...second.body.data].map((r) => r.id)).size).toBe(3);
  expect((await list('q=Sana&creatorId=' + creator)).body.data.length).toBeGreaterThan(0);
});
it('leaves historical attribution unknown and accessible', async () => {
  const result = await list(
    'q=' + legacy + '&registrationSource=NOT_RECORDED&creatorId=NOT_RECORDED',
  );
  expect(result.status).toBe(200);
  expect(result.body.data[0]).toMatchObject({
    id: legacy,
    registrationSource: null,
    registeredByName: null,
    registrationBranchName: null,
  });
  expect(
    (await call(detail, '/api/v1/applicants/' + legacy, { jar: staff, params: { id: legacy } }))
      .status,
  ).toBe(200);
});
it('rejects unauthenticated, foreign branch, foreign creator and foreign detail access', async () => {
  expect((await call(GET, '/api/v1/applicants')).status).toBe(401);
  expect((await list('', await signIn('employer@jobbank.local'))).status).toBe(403);
  expect((await list('branchId=' + otherBranch)).status).toBe(403);
  expect((await list('creatorId=' + foreignCreator)).status).toBe(403);
  expect((await list('q=' + foreignId)).body.data).toEqual([]);
  expect(
    (
      await call(detail, '/api/v1/applicants/' + foreignId, {
        jar: staff,
        params: { id: foreignId },
      })
    ).status,
  ).toBe(403);
  const options = await listApplicantCreators(await loadActor(creator));
  expect(options.some((c) => c.id === creator)).toBe(true);
  expect(options.some((c) => c.id === foreignCreator)).toBe(false);
});
it('validates dates/source and keeps all original provenance through profile edits', async () => {
  expect((await list('registeredFrom=2026-11-08&registeredTo=2026-11-01')).status).toBe(422);
  expect((await list('registeredFrom=invalid')).status).toBe(422);
  expect((await list('registrationSource=FAKE')).status).toBe(422);
  const [before] = await db
    .select()
    .from(schema.applicants)
    .where(eq(schema.applicants.id, ids[0]!));
  expect(
    (
      await call(PATCH, '/api/v1/applicants/' + ids[0], {
        method: 'PATCH',
        jar: staff,
        params: { id: ids[0]! },
        body: { fullName: prefix + ' Edited', reason: 'Correct a spelling mistake' },
      })
    ).status,
  ).toBe(200);
  const [after] = await db
    .select()
    .from(schema.applicants)
    .where(eq(schema.applicants.id, ids[0]!));
  for (const field of [
    'registeredByUserId',
    'registrationBranchId',
    'registrationSource',
    'createdAt',
  ] as const)
    expect(after![field]).toEqual(before![field]);
  await expect(
    owner`UPDATE applicants SET created_at=now() WHERE id=${ids[0]!}`,
  ).rejects.toMatchObject({ code: 'JB001' });
});

it('uses inclusive Pakistan calendar dates at midnight boundaries', async () => {
  const boundaryName = prefix + ' Boundary';
  const boundaryIds: string[] = [];
  for (const createdAt of ['2026-10-31T18:59:59.999Z', '2026-10-31T19:00:00.000Z']) {
    const p = personal();
    const [row] = await db
      .insert(schema.applicants)
      .values({
        fullName: boundaryName,
        fatherName: p.fatherName,
        cnic: p.cnic,
        dateOfBirth: p.dateOfBirth,
        gender: 'MALE',
        branchId: branch,
        registeredByUserId: creator,
        registrationBranchId: branch,
        registrationSource: 'STAFF_ASSISTED',
        createdAt: new Date(createdAt),
      })
      .returning();
    boundaryIds.push(row!.id);
  }
  const result = await list(
    new URLSearchParams({
      q: boundaryName,
      registeredFrom: '2026-11-01',
      registeredTo: '2026-11-01',
    }).toString(),
  );
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  expect(result.body.data.map((r: { id: string }) => r.id)).toEqual([boundaryIds[1]]);
  expect(
    (
      await list('q=' + boundaryName + '&registeredFrom=2026-10-31&registeredTo=2026-10-31')
    ).body.data.map((r: { id: string }) => r.id),
  ).toEqual([boundaryIds[0]]);
});
