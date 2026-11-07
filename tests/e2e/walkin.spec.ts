import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
const req = createRequire(resolve(__dirname, '../../packages/db/package.json'));
const { parse } = req('dotenv');
const postgres = req('postgres');
const config = parse(readFileSync(resolve(__dirname, '../../.env')));
const isolated = new URL(config.DATABASE_URL);
const testDatabase = process.env.TEST_DATABASE_NAME ?? 'jobbank_test';
if (
  !/^jobbank_test(?:_[a-z0-9_]+)?$/.test(testDatabase) ||
  isolated.pathname === '/' + testDatabase
)
  throw Error('Expected a separately named isolated test database');
isolated.pathname = '/' + testDatabase;
const sql = postgres(isolated.toString(), { max: 1, onnotice: () => {} });
test.afterAll(async () => {
  await sql.end();
});
const cnic = () => '42' + String(Math.floor(Math.random() * 1e11)).padStart(11, '0');
async function login(page: import('@playwright/test').Page) {
  const response = await page.request.post('/api/v1/auth/login', {
    data: { email: 'staff.khi@jobbank.local', password: 'JobBank-Dev-2026!' },
  });
  expect(response.status(), await response.text()).toBe(200);
}
async function fill(page: import('@playwright/test').Page, identity: string) {
  await page.getByLabel('CNIC number', { exact: false }).fill(identity);
  await page.getByRole('button', { name: 'Check existing applicant' }).click();
  await expect(page.getByText('No matching applicant is visible', { exact: false })).toBeVisible();
  await page.getByLabel('Full name', { exact: false }).fill('UI Walk In Applicant');
  await page.getByLabel("Father's or husband's name", { exact: false }).fill('UI Parent Name');
  await page.getByLabel('Date of birth', { exact: false }).fill('1995-01-01');
  await page.getByLabel('Gender', { exact: false }).selectOption('MALE');
  await page.getByRole('checkbox', { name: 'The applicant has given consent' }).check();
}
test('real staff flow, validation, persistence, attribution, duplicates and mobile layout', async ({
  page,
}) => {
  await login(page);
  await page.goto('/staff/applicants');
  await page.getByRole('link', { name: 'Add Walk-in Job Seeker' }).click();
  await expect(page.getByRole('heading', { name: 'Add Walk-in Job Seeker' })).toBeVisible();
  await expect(page.locator('input[type=email],input[type=file],input[type=password]')).toHaveCount(
    0,
  );
  await page.getByRole('button', { name: 'Register job seeker', exact: true }).click();
  await expect(page.getByText('Check the highlighted fields.', { exact: true })).toBeVisible();
  const identity = cnic();
  await fill(page, identity);
  await page.getByLabel('Available contact number', { exact: false }).fill('12');
  await page.getByRole('button', { name: 'Register job seeker', exact: true }).click();
  await expect(
    page.getByText('Enter a Pakistani mobile contact number', { exact: true }),
  ).toBeVisible();
  await page.getByLabel('Available contact number', { exact: false }).fill('');
  await expect(
    page.getByText('Record the applicant consent before registering', { exact: true }),
  ).toHaveCount(0);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: 'tests/reports/walkin-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: 'tests/reports/walkin-mobile.png', fullPage: true });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    '**/api/v1/applicants/staff-register',
    async (route) => {
      await gate;
      await route.abort('failed');
    },
    { times: 1 },
  );
  await page.getByRole('button', { name: 'Register job seeker', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Register job seeker', exact: true }),
  ).toHaveAttribute('aria-busy', 'true');
  release();
  await expect(
    page.getByText('Cannot reach the server. Check your internet connection.', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Register job seeker', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Job seeker registered' })).toBeVisible();
  const [row] =
    await sql`SELECT a.*,u.email AS creator_email FROM applicants a JOIN users u ON u.id=a.registered_by_user_id WHERE a.cnic=${identity}`;
  expect(row).toMatchObject({
    user_id: null,
    email: null,
    contact_phone: null,
    registration_source: 'STAFF_ASSISTED',
    identity_status: 'UNVERIFIED',
    status: 'DRAFT',
    creator_email: 'staff.khi@jobbank.local',
  });
  expect(row.registration_branch_id).toBe(row.branch_id);
  await expect(page.getByText(row.id, { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'View profile', exact: true })).toHaveAttribute(
    'href',
    '/staff/applicants/' + row.id,
  );
  const [audit] =
    await sql`SELECT metadata FROM audit_logs WHERE entity_id=${row.id} AND action='applicant.staff_register'`;
  expect(audit.metadata.consent.accepted).toBe(true);
  await page.getByRole('button', { name: 'Add another job seeker' }).click();
  await page.getByLabel('CNIC number', { exact: false }).fill(identity);
  await page.getByRole('button', { name: 'Check existing applicant' }).click();
  await expect(
    page.getByText('An applicant with this CNIC already exists.', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Register job seeker', exact: true }),
  ).toBeDisabled();
  await page.getByRole('link', { name: /UI Walk In Applicant/ }).click();
  await expect(
    page.getByRole('heading', { name: 'UI Walk In Applicant', exact: true }),
  ).toBeVisible();
  await page.goto('/staff/applicants?q=' + row.id);
  await page.reload();
  await expect(page.locator('tbody')).toContainText(row.id);
});

test('server duplicate race and dashboard role guards use real backend responses', async ({
  page,
}) => {
  await page.goto('/staff/applicants/new');
  await expect(page).toHaveURL(/\/login/);
  await login(page);
  await page.goto('/branch-admin/applicants/new');
  await expect(page).toHaveURL(/\/forbidden/);
  await page.goto('/staff/applicants/new');
  const identity = cnic();
  await fill(page, identity);
  const existing = await page.request.post('/api/v1/applicants/staff-register', {
    headers: { 'idempotency-key': crypto.randomUUID() },
    data: {
      fullName: 'UI Walk In Applicant',
      fatherName: 'UI Parent Name',
      cnic: identity,
      dateOfBirth: '1995-01-01',
      gender: 'MALE',
      consent: true,
    },
  });
  expect(existing.status(), await existing.text()).toBe(201);
  await page.getByRole('button', { name: 'Register job seeker', exact: true }).click();
  await expect(
    page.getByText(
      'This CNIC is already registered. Check the existing applicant. If the record is outside your scope, contact your branch administrator.',
      { exact: true },
    ),
  ).toBeVisible();
  const rows = await sql`SELECT id FROM applicants WHERE cnic=${identity}`;
  expect(rows).toHaveLength(1);
});

test('phase5 attribution, filters, pagination, historical records and responsive details', async ({
  page,
}) => {
  await login(page);
  const name = 'Attribution Browser ' + crypto.randomUUID().slice(0, 8).replace(/[0-9]/g, 'a');
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const result = await page.request.post('/api/v1/applicants/staff-register', {
      headers: { 'idempotency-key': crypto.randomUUID() },
      data: {
        fullName: name,
        fatherName: 'Parent Name',
        cnic: cnic(),
        dateOfBirth: '1995-01-01',
        gender: 'MALE',
        consent: true,
      },
    });
    expect(result.status(), await result.text()).toBe(201);
    ids.push((await result.json()).data.id);
  }
  const [record] = await sql`SELECT * FROM applicants WHERE id=${ids[0]}`;
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(record.created_at));
  const params = new URLSearchParams({
    q: name,
    creatorId: record.registered_by_user_id,
    registrationSource: 'STAFF_ASSISTED',
    registeredFrom: date,
    registeredTo: date,
    pageSize: '1',
    sort: 'createdAt:asc',
  });
  await page.goto('/staff/applicants?' + params.toString());
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await expect(page.locator('tbody')).toContainText('Added by: Sana Staff (Karachi)');
  await expect(page.locator('tbody')).toContainText('Staff-assisted');
  await expect(page.locator('tbody')).toContainText('Registration branch: Karachi');
  await expect(page.getByRole('combobox', { name: 'Filter by added by' })).toHaveValue(
    record.registered_by_user_id,
  );
  const options = await page
    .getByRole('combobox', { name: 'Filter by added by' })
    .locator('option')
    .allTextContents();
  expect(options).not.toContain('Usman Staff (Lahore)');
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(page).toHaveURL(/page=2/);
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: 'tests/reports/attribution-list-mobile.png', fullPage: true });
  await page.goto('/staff/applicants/' + ids[0]);
  const registration = page
    .getByRole('heading', { name: 'Registration', exact: true })
    .locator('..')
    .locator('..');
  await expect(registration).toContainText(ids[0]!);
  await expect(registration).toContainText('Sana Staff (Karachi)');
  await expect(registration).toContainText('Staff-assisted');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: 'tests/reports/attribution-detail-mobile.png', fullPage: true });
  const [historical] =
    await sql`SELECT id FROM applicants WHERE registration_source IS NULL AND branch_id=${record.branch_id} LIMIT 1`;
  expect(historical).toBeTruthy();
  await page.goto('/staff/applicants/' + historical.id);
  const old = page
    .getByRole('heading', { name: 'Registration', exact: true })
    .locator('..')
    .locator('..');
  await expect(old.getByText('Not recorded', { exact: true })).toHaveCount(3);
});

test('phase6 assisted corrections and consented existing shortlist without an account', async ({
  page,
}) => {
  await login(page);
  const response = await page.request.post('/api/v1/applicants/staff-register', {
    headers: { 'idempotency-key': crypto.randomUUID() },
    data: {
      fullName: 'Assisted Browser Candidate',
      fatherName: 'Parent Name',
      cnic: cnic(),
      dateOfBirth: '1995-01-01',
      gender: 'MALE',
      consent: true,
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  const id = (await response.json()).data.id;
  const [before] = await sql`SELECT * FROM applicants WHERE id=${id}`;
  await page.goto('/staff/applicants/' + id);
  await expect(page.getByRole('button', { name: 'Change mobile', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Correct details', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Correct personal details' });
  await expect(dialog.locator('input[type=email],input[type=file]')).toHaveCount(0);
  await dialog.getByLabel('Available contact number', { exact: false }).fill('3001234567');
  await dialog
    .getByLabel('Reason for the correction', { exact: false })
    .fill('Update available shared contact');
  await dialog.getByRole('button', { name: 'Save correction' }).click();
  await expect(dialog).not.toBeVisible();
  const [edited] = await sql`SELECT * FROM applicants WHERE id=${id}`;
  expect(edited.contact_phone).toBe('+923001234567');
  expect(edited.user_id).toBeNull();
  expect(edited.email).toBeNull();
  for (const key of [
    'registered_by_user_id',
    'registration_branch_id',
    'registration_source',
    'created_at',
  ])
    expect(edited[key]).toEqual(before[key]);
  // Isolated matching evidence fixture, not a claim that a live Python run succeeded.
  await sql`UPDATE applicants SET status='ACTIVE' WHERE id=${id}`;
  await sql`INSERT INTO applicant_addresses (applicant_id,address_line,city_code,location) VALUES (${id},'Test home','KARACHI',ST_SetSRID(ST_MakePoint(67.0899,24.9256),4326)::geography)`;
  const [company] = await sql`SELECT id FROM companies WHERE branch_id=${before.branch_id} LIMIT 1`;
  const [job] =
    await sql`INSERT INTO jobs (company_id,branch_id,title,category_code,description,job_type,shift,vacancies,status,created_by) VALUES (${company.id},${before.branch_id},'Browser Assisted Job','CALL_CENTRE','Isolated UI fixture','FULL_TIME','DAY',1,'OPEN',${before.registered_by_user_id}) RETURNING id`;
  await sql`INSERT INTO job_locations (job_id,address_line,city_code,location) VALUES (${job.id},'Test workplace','KARACHI',ST_SetSRID(ST_MakePoint(67.0899,24.9256),4326)::geography)`;
  const [run] =
    await sql`INSERT INTO match_runs (job_id,trigger_type,status,started_at,completed_at) VALUES (${job.id},'MANUAL','COMPLETED',now(),now()) RETURNING id`;
  await sql`INSERT INTO job_matches (run_id,job_id,applicant_id,score,distance_m,summary) VALUES (${run.id},${job.id},${id},90,1000,'Isolated recorded eligibility fixture')`;
  await page.reload();
  await page.getByRole('button', { name: 'Shortlist for job', exact: true }).click();
  const shortlist = page.getByRole('dialog', { name: 'Shortlist for a job' });
  await shortlist.getByLabel('Job', { exact: false }).selectOption(job.id);
  await expect(shortlist.getByText(/current eligible match is recorded/)).toBeVisible();
  await expect(shortlist.getByRole('button', { name: 'Shortlist', exact: true })).toBeDisabled();
  await expect(
    shortlist.getByText('Selected job: Browser Assisted Job', { exact: true }),
  ).toBeVisible();
  await shortlist
    .getByRole('checkbox', { name: 'The applicant agrees to be shortlisted for this selected job' })
    .check();
  await shortlist.getByRole('button', { name: 'Shortlist', exact: true }).click();
  await expect(shortlist).not.toBeVisible();
  const rows = await sql`SELECT * FROM applications WHERE applicant_id=${id} AND job_id=${job.id}`;
  expect(rows).toHaveLength(1);
  expect(rows[0].created_by).toBe(before.registered_by_user_id);
  expect(rows[0].status).toBe('SHORTLISTED');
  const [audit] =
    await sql`SELECT metadata FROM audit_logs WHERE entity_id=${rows[0].id} AND action='application.shortlist'`;
  expect(audit.metadata.consent.accepted).toBe(true);
});

test('phase7 branch admin uses real enrollment and authenticator login before walk-in intake', async ({
  page,
}) => {
  const [admin] =
    await sql`SELECT id,two_factor_enabled FROM users WHERE email='branchadmin.khi@jobbank.local'`;
  test.skip(
    admin.two_factor_enabled,
    'Enrollment requires a fresh fixture; never reset 2FA to rerun',
  );
  async function passwordLogin() {
    await page.goto('/login');
    await page.getByRole('button', { name: /Staff \/ Admin/ }).click();
    await page.getByLabel(/Email/).fill('branchadmin.khi@jobbank.local');
    await page.getByLabel(/Password/).fill('JobBank-Dev-2026!');
    const response = page.waitForResponse(
      (r) => r.url().endsWith('/api/v1/auth/login') && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    expect((await response).status()).toBe(200);
  }
  await passwordLogin();
  // Verify the authoritative server redirect on a full navigation, independent of cold RSC transitions.
  await page.goto('/branch-admin');
  await expect(page).toHaveURL(/\/account\/security/);
  const denied = await page.request.post('/api/v1/applicants/staff-register', {
    headers: { 'idempotency-key': crypto.randomUUID() },
    data: {},
  });
  expect(denied.status()).toBe(403);
  await page.getByLabel('Your password', { exact: false }).fill('JobBank-Dev-2026!');
  const enrollmentResponse = page.waitForResponse(
    (r) => r.url().endsWith('/api/v1/account/2fa/enroll') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  const enrollment = await (await enrollmentResponse).json();
  const webRequire = createRequire(resolve(__dirname, '../../apps/web/package.json'));
  const OTPAuth = webRequire('otpauth');
  const authenticator = new OTPAuth.TOTP({
    secret: OTPAuth.Secret.fromBase32(enrollment.data.manualKey),
    digits: 6,
    period: 30,
    algorithm: 'SHA1',
  });
  await page.getByRole('checkbox', { name: 'I have saved my backup codes' }).check();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByLabel('Digit 1 of 6', { exact: true }).fill(authenticator.generate());
  await expect(page).toHaveURL(/\/branch-admin$/);
  await page.request.post('/api/v1/auth/logout');
  await passwordLogin();
  await expect(page.getByRole('group', { name: 'Authenticator code' })).toBeVisible();
  await page.getByLabel('Digit 1 of 6', { exact: true }).fill(authenticator.generate());
  await expect(page).toHaveURL(/\/branch-admin$/);
  await page.goto('/branch-admin/applicants/new');
  await expect(page.locator('input[type=email],input[type=file],input[type=password]')).toHaveCount(
    0,
  );
  const identity = cnic();
  await fill(page, identity);
  await page.getByRole('button', { name: 'Register job seeker', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Job seeker registered' })).toBeVisible();
  const [saved] = await sql`SELECT * FROM applicants WHERE cnic=${identity}`;
  expect(saved.registered_by_user_id).toBe(admin.id);
  expect(saved.user_id).toBeNull();
  expect(saved.email).toBeNull();
  const [secured] = await sql`SELECT two_factor_enabled FROM users WHERE id=${admin.id}`;
  expect(secured.two_factor_enabled).toBe(true);
});

test('staff applicant list hydrates without mismatched IDs after full reload', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (
      message.type() === 'error' &&
      /hydrat|server rendered|server-rendered|didn.t match/i.test(message.text())
    )
      errors.push(message.text());
  });
  await login(page);
  for (let i = 0; i < 2; i++) {
    await page.goto('/staff/applicants');
    await expect(page.getByRole('link', { name: 'Add Walk-in Job Seeker' })).toBeVisible();
    await expect(page.getByLabel('Registered from', { exact: true })).toBeVisible();
    await page.getByLabel('Registered from', { exact: true }).focus();
    await page.getByRole('button', { name: /^Notifications/ }).click();
    await expect(page.getByRole('menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /^Account menu for/ }).click();
    await expect(page.getByRole('menu')).toBeVisible();
    await page.keyboard.press('Escape');
  }
  expect(errors).toEqual([]);
});
