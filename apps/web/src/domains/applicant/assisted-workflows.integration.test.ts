import { schema } from '@jobbank/db';
import { and, eq, sql } from 'drizzle-orm';
import { beforeAll, expect, it, vi } from 'vitest';
import { POST as register } from '@/app/api/v1/applicants/staff-register/route';
import { PATCH as edit } from '@/app/api/v1/applicants/[id]/route';
import { POST as verify } from '@/app/api/v1/applicants/[id]/identity-verification/route';
import { POST as submit, GET as matching } from '@/app/api/v1/applications/route';
import { POST as interview } from '@/app/api/v1/applications/[id]/interview/route';
import { POST as employerDecision } from '@/app/api/v1/applications/[id]/employer-decision/route';
import { listApplicationsForApplicant } from '@/domains/placement';
import { loadActor } from '@/domains/auth';
import { db } from '@/lib/db';
import { call, signIn, signInAdmin } from '@/test/api-client';
let staff: Awaited<ReturnType<typeof signIn>>;
let foreign: Awaited<ReturnType<typeof signIn>>;
let creator: string, branch: string, otherBranch: string, company: string;
const personal = () => ({
  fullName: 'Assisted Integration',
  fatherName: 'Parent Name',
  cnic: '42' + String(Math.floor(Math.random() * 1e11)).padStart(11, '0'),
  dateOfBirth: '1995-01-01',
  gender: 'MALE',
  consent: true,
});
async function applicant() {
  const result = await call(register, '/api/v1/applicants/staff-register', {
    method: 'POST',
    jar: staff,
    body: personal(),
    headers: { 'idempotency-key': crypto.randomUUID() },
  });
  expect(result.status, JSON.stringify(result.body)).toBe(201);
  return result.body.data.id as string;
}
async function fixture(active = true) {
  const id = await applicant();
  if (active)
    await db
      .update(schema.applicants)
      .set({ status: 'ACTIVE' })
      .where(eq(schema.applicants.id, id));
  const [job] = await db
    .insert(schema.jobs)
    .values({
      companyId: company,
      branchId: branch,
      title: 'Assisted Test Job',
      categoryCode: 'CALL_CENTRE',
      description: 'Test fixture',
      jobType: 'FULL_TIME',
      shift: 'DAY',
      vacancies: 1,
      status: 'OPEN',
      createdBy: creator,
    })
    .returning();
  return { id, job: job! };
}
const check = (id: string, job: string, jar = staff) =>
  call(matching, '/api/v1/applications?' + new URLSearchParams({ applicantId: id, jobId: job }), {
    jar,
  });
const apply = (id: string, job: string, consent?: boolean, jar = staff) =>
  call(submit, '/api/v1/applications', {
    method: 'POST',
    jar,
    body: { applicantId: id, jobId: job, consent },
  });
async function run(
  id: string,
  job: string,
  status: 'COMPLETED' | 'FAILED' = 'COMPLETED',
  matched = true,
) {
  const [r] = await db
    .insert(schema.matchRuns)
    .values({
      jobId: job,
      triggerType: 'MANUAL',
      status,
      startedAt: sql`now()`,
      completedAt: sql`now()`,
      scoringVersion: 'v1',
    })
    .returning();
  if (matched)
    await db.insert(schema.jobMatches).values({
      runId: r!.id,
      jobId: job,
      applicantId: id,
      score: 90,
      distanceM: 1000,
      summary: 'Isolated stored worker evidence fixture',
    });
  return r!;
}
beforeAll(async () => {
  staff = await signIn('staff.khi@jobbank.local');
  foreign = await signIn('staff.lhr@jobbank.local');
  creator = (
    await db.select().from(schema.users).where(eq(schema.users.email, 'staff.khi@jobbank.local'))
  )[0]!.id;
  branch = (
    await db.select().from(schema.branches).where(eq(schema.branches.code, 'KHI-GULSHAN'))
  )[0]!.id;
  otherBranch = (
    await db.select().from(schema.branches).where(eq(schema.branches.code, 'LHR-JOHAR'))
  )[0]!.id;
  const [c] = await db
    .insert(schema.companies)
    .values({
      branchId: branch,
      legalName: 'Assisted Test ' + crypto.randomUUID(),
      legalStructure: 'PRIVATE_LIMITED',
      ntn: String(Math.floor(1e6 + Math.random() * 9e6)),
      industryCode: 'RETAIL',
      sizeBand: '1_10',
      createdBy: creator,
    })
    .returning();
  company = c!.id;
});
it('edits optional shared contact without email, credentials or changing provenance', async () => {
  const id = await applicant();
  const [before] = await db.select().from(schema.applicants).where(eq(schema.applicants.id, id));
  const result = await call(edit, '/api/v1/applicants/' + id, {
    method: 'PATCH',
    jar: staff,
    params: { id },
    body: { contactPhone: '+923001234567', reason: 'Update available family contact' },
  });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  const [after] = await db.select().from(schema.applicants).where(eq(schema.applicants.id, id));
  expect(after).toMatchObject({
    contactPhone: '+923001234567',
    userId: null,
    email: null,
    identityStatus: 'UNVERIFIED',
  });
  for (const field of [
    'registeredByUserId',
    'registrationBranchId',
    'registrationSource',
    'createdAt',
  ] as const)
    expect(after![field]).toEqual(before![field]);
  const [audit] = await db
    .select()
    .from(schema.auditLogs)
    .where(
      and(eq(schema.auditLogs.entityId, id), eq(schema.auditLogs.action, 'applicant.staff_update')),
    );
  expect(audit!.after).toMatchObject({ contactPhone: '[REDACTED]' });
  expect(
    (
      await call(edit, '/api/v1/applicants/' + id, {
        method: 'PATCH',
        jar: staff,
        params: { id },
        body: { email: 'x@example.test', reason: 'Attempt email override' },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await call(edit, '/api/v1/applicants/' + id, {
        method: 'PATCH',
        jar: foreign,
        params: { id },
        body: { fullName: 'Wrong Branch', reason: 'Attempt foreign edit' },
      })
    ).status,
  ).toBe(403);
});
it('reuses in-person verification without account/OTP and without auto-activation', async () => {
  const id = await applicant();
  const result = await call(verify, '/api/v1/applicants/' + id + '/identity-verification', {
    method: 'POST',
    jar: staff,
    params: { id },
    body: {
      method: 'IN_PERSON',
      outcome: 'VERIFIED',
      notes: 'Original CNIC checked in isolated test',
    },
  });
  expect(result.status, JSON.stringify(result.body)).toBe(201);
  expect(result.body.data).toMatchObject({
    identityStatus: 'VERIFIED',
    status: 'DRAFT',
    userId: null,
  });
  const admin = await signInAdmin('branchadmin.khi@jobbank.local');
  const another = await applicant();
  expect(
    (
      await call(verify, '/api/v1/applicants/' + another + '/identity-verification', {
        method: 'POST',
        jar: admin,
        params: { id: another },
        body: { method: 'IN_PERSON', outcome: 'VERIFIED' },
      })
    ).status,
  ).toBe(403);
});
it('registers and reports unavailable matching without making a Python call', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Worker unavailable'));
  try {
    const f = await fixture(false);
    expect((await check(f.id, f.job.id)).body.data.status).toBe('PROFILE_OR_JOB_NOT_READY');
    expect((await apply(f.id, f.job.id, true)).status).toBe(409);
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    fetch.mockRestore();
  }
});
it('blocks missing, failed, absent-candidate and stale results', async () => {
  const f = await fixture();
  expect((await check(f.id, f.job.id)).body.data).toMatchObject({
    status: 'NOT_RUN',
    eligible: false,
    liveServiceStatus: 'NOT_CHECKED',
  });
  expect((await apply(f.id, f.job.id, true)).status).toBe(409);
  await run(f.id, f.job.id, 'FAILED', false);
  expect((await check(f.id, f.job.id)).body.data.status).toBe('FAILED');
  await run(f.id, f.job.id, 'COMPLETED', false);
  expect((await apply(f.id, f.job.id, true)).status).toBe(409);
  await run(f.id, f.job.id);
  await db
    .update(schema.applicants)
    .set({ fullName: 'Changed Details' })
    .where(eq(schema.applicants.id, f.id));
  expect((await check(f.id, f.job.id)).body.data.status).toBe('STALE');
  expect((await apply(f.id, f.job.id, true)).status).toBe(409);
});
it('requires selected-job consent, audits actual submission and prevents duplicate races', async () => {
  const f = await fixture();
  await run(f.id, f.job.id);
  expect((await check(f.id, f.job.id)).body.data.eligible).toBe(true);
  expect((await apply(f.id, f.job.id)).status).toBe(422);
  const result = await Promise.all([apply(f.id, f.job.id, true), apply(f.id, f.job.id, true)]);
  expect(result.map((r) => r.status).sort()).toEqual([201, 409]);
  const [saved] = await db
    .select()
    .from(schema.applications)
    .where(and(eq(schema.applications.applicantId, f.id), eq(schema.applications.jobId, f.job.id)));
  expect(saved).toMatchObject({ createdBy: creator, status: 'SHORTLISTED' });
  expect(saved!.createdAt).toBeInstanceOf(Date);
  const [audit] = await db
    .select()
    .from(schema.auditLogs)
    .where(
      and(
        eq(schema.auditLogs.entityId, saved!.id),
        eq(schema.auditLogs.action, 'application.shortlist'),
      ),
    );
  expect(audit).toMatchObject({
    actorUserId: creator,
    metadata: { jobId: f.job.id, consent: { accepted: true, version: 'assisted-application-v1' } },
  });
  expect(
    (
      await call(employerDecision, '/api/v1/applications/' + saved!.id + '/employer-decision', {
        method: 'POST',
        jar: staff,
        params: { id: saved!.id },
        body: { decision: 'ACCEPTED' },
      })
    ).status,
  ).toBe(403);
  expect((await check(f.id, f.job.id, foreign)).status).toBe(403);
  expect(
    (
      await call(interview, '/api/v1/applications/' + saved!.id + '/interview', {
        method: 'POST',
        jar: foreign,
        params: { id: saved!.id },
        body: { interviewAt: new Date(Date.now() + 86400000).toISOString() },
      })
    ).status,
  ).toBe(403);
  await expect(
    listApplicationsForApplicant(
      await loadActor(
        (
          await db
            .select()
            .from(schema.users)
            .where(eq(schema.users.email, 'staff.lhr@jobbank.local'))
        )[0]!.id,
      ),
      f.id,
    ),
  ).rejects.toThrow();
});
it('rejects jobs outside staff scope even for a visible applicant', async () => {
  const f = await fixture();
  await db.update(schema.jobs).set({ branchId: otherBranch }).where(eq(schema.jobs.id, f.job.id));
  expect((await check(f.id, f.job.id)).status).toBe(403);
  expect((await apply(f.id, f.job.id, true)).status).toBe(403);
});

it('queues matching refresh without claiming worker completion', async () => {
  const { POST: refresh } = await import('@/app/api/v1/jobs/[id]/matches/refresh/route');
  const f = await fixture();
  const result = await call(refresh, '/api/v1/jobs/' + f.job.id + '/matches/refresh', {
    method: 'POST',
    jar: staff,
    params: { id: f.job.id },
  });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  expect(result.body.data).toEqual({ queued: true });
  expect((await check(f.id, f.job.id)).body.data).toMatchObject({
    status: 'PENDING',
    eligible: false,
    liveServiceStatus: 'NOT_CHECKED',
  });
  expect((await apply(f.id, f.job.id, true)).status).toBe(409);
});

it('keeps employer hiring exclusive and preserves a real owning-employer decision', async () => {
  const { PATCH: decision } = await import('@/app/api/v1/jobs/[id]/matches/[applicantId]/route');
  const f = await fixture();
  await run(f.id, f.job.id);
  expect(
    (
      await call(decision, '/api/v1/jobs/' + f.job.id + '/matches/' + f.id, {
        method: 'PATCH',
        jar: staff,
        params: { id: f.job.id, applicantId: f.id },
        body: { reviewStatus: 'HIRED' },
      })
    ).status,
  ).toBe(403);
  const employer = await signIn('employer@jobbank.local');
  const [user] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.email, 'employer@jobbank.local'));
  const actor = await loadActor(user!.id);
  expect(actor.companyId).toBeTruthy();
  const [ownedCompany] = await db
    .select()
    .from(schema.companies)
    .where(eq(schema.companies.id, actor.companyId!));
  if (!ownedCompany?.branchId) throw new Error('Owning employer fixture needs a branch');
  const [job] = await db
    .insert(schema.jobs)
    .values({
      companyId: actor.companyId!,
      branchId: ownedCompany!.branchId,
      title: 'Owned Employer Regression',
      categoryCode: 'CALL_CENTRE',
      description: 'Isolated owner context',
      jobType: 'FULL_TIME',
      shift: 'DAY',
      vacancies: 1,
      status: 'OPEN',
      createdBy: user!.id,
    })
    .returning();
  await run(f.id, job!.id);
  const result = await call(decision, '/api/v1/jobs/' + job!.id + '/matches/' + f.id, {
    method: 'PATCH',
    jar: employer,
    params: { id: job!.id, applicantId: f.id },
    body: { reviewStatus: 'HIRED' },
  });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  const [profile] = await db.select().from(schema.applicants).where(eq(schema.applicants.id, f.id));
  expect(profile!.userId).toBeNull();
});
