'use client';

import {
  cnicSchema,
  GENDERS,
  GENDER_LABELS,
  staffRegisterApplicantSchema,
  WALK_IN_CONSENT_NOTICE,
} from '@jobbank/shared';
import { useRef, useState, type FormEvent } from 'react';
import { Button, Checkbox, Input, Link, Select, Textarea } from '@/components/atoms';
import { MonthYearPicker } from '../../applicant/_components/MonthYearPicker';
import { RepeatableList } from '../../applicant/_components/RepeatableList';
import { CNICInput, FormField, PhoneInput } from '@/components/molecules';
import { apiFetch, ApiClientError } from '@/lib/api/client';
import { errorMessage, toFieldErrors, zodFieldErrors, type FieldErrors } from './form';

type Match = { id: string; fullName: string; cnicMasked: string; branchName: string | null };
type Result = { id: string; createdAt: string; registrationSource: string };
const empty = {
  fullName: '',
  fatherName: '',
  cnic: '',
  dateOfBirth: '',
  gender: '',
  contactPhone: '',
};

export function WalkInForm({
  branches,
  basePath,
  categories,
}: {
  branches: { id: string; name: string }[];
  basePath: string;
  categories: { value: string; label: string }[];
}) {
  const [form, setForm] = useState(empty);
  const [noExperience, setNoExperience] = useState(false);
  const [jobs, setJobs] = useState<
    {
      employerName: string;
      jobTitle: string;
      categoryCode: string;
      startMonth: string;
      endMonth: string;
      isCurrent: boolean;
      description: string;
    }[]
  >([]);
  const [wantedCategories, setWantedCategories] = useState<string[]>([]);
  const [branchId, setBranchId] = useState('');
  const [consent, setConsent] = useState(false);
  const [pending, setPending] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkedCnic, setCheckedCnic] = useState<string | null>(null);
  const [matches, setMatches] = useState<Match[]>([]);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [alert, setAlert] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const retry = useRef<{ payload: string; key: string } | null>(null);
  const busy = pending || checking;

  function set(field: keyof typeof empty, value: string) {
    setAlert(null);
    setForm((current) => ({ ...current, [field]: value }));
    setErrors((current) => {
      const next = { ...current };
      delete next[field];
      return next;
    });
    if (field === 'cnic') {
      setCheckedCnic(null);
      setMatches([]);
    }
  }
  async function checkApplicant() {
    setAlert(null);
    const parsed = cnicSchema.safeParse(form.cnic);
    if (!parsed.success) {
      setErrors((e) => ({ ...e, cnic: parsed.error.issues[0]?.message ?? 'Enter a valid CNIC' }));
      return;
    }
    setChecking(true);
    try {
      const { data } = await apiFetch<Match[]>(
        '/api/v1/applicants?q=' + encodeURIComponent(parsed.data),
      );
      setMatches(data);
      setCheckedCnic(parsed.data);
      setErrors((e) => {
        const next = { ...e };
        delete next.cnic;
        return next;
      });
    } catch (error) {
      setCheckedCnic(null);
      setAlert(errorMessage(error));
    } finally {
      setChecking(false);
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setAlert(null);
    const parsed = staffRegisterApplicantSchema.safeParse({
      ...form,
      consent,
      ...(noExperience || jobs.length
        ? {
            experience: {
              hasNoExperience: noExperience,
              items: noExperience
                ? []
                : jobs.map((j) => ({
                    ...j,
                    categoryCode: j.categoryCode || null,
                    endMonth: j.isCurrent ? null : j.endMonth || null,
                    description: j.description || null,
                  })),
            },
          }
        : {}),
      ...(wantedCategories.length
        ? { preferences: { categoryCodes: wantedCategories, shifts: [], jobTypes: [] } }
        : {}),
      ...(branches.length > 1 ? { branchId } : {}),
    });
    if (!parsed.success) {
      setErrors(zodFieldErrors(parsed.error));
      setAlert('Check the highlighted fields.');
      return;
    }
    if (checkedCnic !== parsed.data.cnic) {
      setAlert('Check this CNIC for an existing applicant before registering.');
      return;
    }
    if (matches.length) {
      setAlert('An applicant with this CNIC already exists. Open the existing profile.');
      return;
    }
    setErrors({});
    const payload = JSON.stringify(parsed.data);
    if (retry.current?.payload !== payload) retry.current = { payload, key: crypto.randomUUID() };
    setPending(true);
    try {
      const { data } = await apiFetch<Result>('/api/v1/applicants/staff-register', {
        method: 'POST',
        body: parsed.data,
        idempotencyKey: retry.current!.key,
      });
      setResult(data);
    } catch (error) {
      if (error instanceof ApiClientError && error.issues.length)
        setErrors(toFieldErrors(error.issues));
      setAlert(
        error instanceof ApiClientError &&
          error.status === 409 &&
          (error.details as { reason?: string } | null)?.reason === 'CNIC_TAKEN'
          ? 'This CNIC is already registered. Check the existing applicant. If the record is outside your scope, contact your branch administrator.'
          : errorMessage(error),
      );
    } finally {
      setPending(false);
    }
  }
  function reset() {
    setForm(empty);
    setNoExperience(false);
    setJobs([]);
    setWantedCategories([]);
    setConsent(false);
    setBranchId('');
    setCheckedCnic(null);
    setMatches([]);
    setErrors({});
    setAlert(null);
    setResult(null);
    retry.current = null;
  }
  if (result)
    return (
      <section
        aria-label="Registration successful"
        className="border-border bg-surface grid max-w-2xl gap-5 rounded-xl border p-4 sm:p-6"
      >
        <div role="status">
          <h2 className="text-fg text-xl font-semibold">Job seeker registered</h2>
          <p className="text-fg-muted mt-2 text-sm">
            The applicant has been saved. Identity verification and activation requirements remain
            unchanged.
          </p>
        </div>
        <div>
          <p className="text-fg-muted text-sm">Applicant reference</p>
          <p className="text-fg font-mono text-sm break-all">{result.id}</p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Button asChild>
            <Link href={`${basePath}/${result.id}`} variant="unstyled">
              View profile
            </Link>
          </Button>
          <Button variant="secondary" onClick={reset}>
            Add another job seeker
          </Button>
        </div>
      </section>
    );
  return (
    <form
      onSubmit={submit}
      noValidate
      className="border-border bg-surface grid max-w-2xl gap-6 rounded-xl border p-4 sm:p-6"
    >
      <fieldset disabled={busy} className="grid min-w-0 gap-5">
        <legend className="text-fg mb-4 font-semibold">Applicant information</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            label="CNIC number"
            required
            error={errors.cnic}
            hint="Check the 13-digit CNIC before creating a record."
            className="sm:col-span-2"
          >
            <CNICInput value={form.cnic} onChange={(v) => set('cnic', v.digits)} />
          </FormField>
          <div className="sm:col-span-2">
            <Button variant="secondary" onClick={checkApplicant} loading={checking} disabled={busy}>
              Check existing applicant
            </Button>
          </div>
          {checkedCnic && (
            <div
              role="status"
              className="bg-surface-muted text-fg grid gap-2 rounded-lg p-3 text-sm sm:col-span-2"
            >
              {matches.length ? (
                <>
                  <p>An applicant with this CNIC already exists.</p>
                  {matches.map((m) => (
                    <Link key={m.id} href={`${basePath}/${m.id}`}>
                      {m.fullName} · {m.cnicMasked}
                      {m.branchName ? ` · ${m.branchName}` : ''} — View profile
                    </Link>
                  ))}
                </>
              ) : (
                <p>
                  No matching applicant is visible in your scope. Registration will also check for
                  duplicate CNICs.
                </p>
              )}
            </div>
          )}
          <FormField label="Full name" required error={errors.fullName}>
            <Input
              autoComplete="off"
              value={form.fullName}
              onChange={(e) => set('fullName', e.target.value)}
            />
          </FormField>
          <FormField label="Father's or husband's name" required error={errors.fatherName}>
            <Input
              autoComplete="off"
              value={form.fatherName}
              onChange={(e) => set('fatherName', e.target.value)}
            />
          </FormField>
          <FormField
            label="Date of birth"
            required
            error={errors.dateOfBirth}
            hint="Applicant must be aged 18–80."
          >
            <Input
              type="date"
              value={form.dateOfBirth}
              onChange={(e) => set('dateOfBirth', e.target.value)}
            />
          </FormField>
          <FormField label="Gender" required error={errors.gender}>
            <Select
              placeholder="Choose an option"
              options={GENDERS.map((g) => ({ value: g, label: GENDER_LABELS[g] }))}
              value={form.gender}
              onChange={(e) => set('gender', e.target.value)}
            />
          </FormField>
          <FormField
            label="Available contact number"
            error={errors.contactPhone}
            hint="Optional Pakistani mobile number. May belong to family or be shared; it is not a login."
            className="sm:col-span-2"
          >
            <PhoneInput
              value={form.contactPhone}
              onChange={(v) => set('contactPhone', v.e164 || v.national)}
            />
          </FormField>
          {branches.length > 1 ? (
            <FormField
              label="Registration branch"
              required
              error={errors.branchId}
              className="sm:col-span-2"
            >
              <Select
                placeholder="Choose an assigned branch"
                options={branches.map((b) => ({ value: b.id, label: b.name }))}
                value={branchId}
                onChange={(e) => {
                  setBranchId(e.target.value);
                  setErrors((current) => {
                    const next = { ...current };
                    delete next.branchId;
                    return next;
                  });
                }}
              />
            </FormField>
          ) : (
            <div className="text-fg-muted text-sm sm:col-span-2">
              <p>Registration branch: {branches[0]?.name}</p>
              {errors.branchId && (
                <p role="alert" className="text-danger">
                  {errors.branchId}
                </p>
              )}
            </div>
          )}
        </div>
        <fieldset className="border-border grid min-w-0 gap-4 border-t pt-5">
          <legend className="text-fg pt-5 font-semibold">Work experience</legend>
          <Checkbox
            label="The applicant has no work experience (fresher)"
            checked={noExperience}
            onCheckedChange={(v) => setNoExperience(v === true)}
          />
          {!noExperience && (
            <RepeatableList
              items={jobs}
              onChange={setJobs}
              max={15}
              itemLabel={(i) => 'Previous job ' + (i + 1)}
              addLabel={jobs.length ? 'Add another experience' : 'Add work experience'}
              emptyHint="Record relevant work, including informal work. Leave blank if details are not available."
              createItem={() => ({
                employerName: '',
                jobTitle: '',
                categoryCode: '',
                startMonth: '',
                endMonth: '',
                isCurrent: false,
                description: '',
              })}
              renderItem={(row, update, i) => (
                <div className="grid min-w-0 gap-4 sm:grid-cols-2">
                  <FormField
                    label="Employer / workplace"
                    required
                    error={errors['experience.items.' + i + '.employerName']}
                  >
                    <Input
                      value={row.employerName}
                      onChange={(e) => update({ employerName: e.target.value })}
                    />
                  </FormField>
                  <FormField
                    label="Job title / work performed"
                    required
                    error={errors['experience.items.' + i + '.jobTitle']}
                  >
                    <Input
                      value={row.jobTitle}
                      onChange={(e) => update({ jobTitle: e.target.value })}
                    />
                  </FormField>
                  <FormField
                    label="Experience related to"
                    error={errors['experience.items.' + i + '.categoryCode']}
                  >
                    <Select
                      placeholder="Choose a work category"
                      options={categories}
                      value={row.categoryCode}
                      onChange={(e) => update({ categoryCode: e.target.value })}
                    />
                  </FormField>
                  <Checkbox
                    label="Currently working here"
                    checked={row.isCurrent}
                    onCheckedChange={(v) => update({ isCurrent: v === true, endMonth: '' })}
                  />
                  <FormField
                    label="Started (month)"
                    required
                    error={errors['experience.items.' + i + '.startMonth']}
                  >
                    <MonthYearPicker
                      value={row.startMonth}
                      onChange={(v) => update({ startMonth: v })}
                      maxYear={new Date().getFullYear()}
                    />
                  </FormField>
                  {!row.isCurrent && (
                    <FormField
                      label="Ended (month)"
                      required
                      error={errors['experience.items.' + i + '.endMonth']}
                    >
                      <MonthYearPicker
                        value={row.endMonth}
                        onChange={(v) => update({ endMonth: v })}
                        maxYear={new Date().getFullYear()}
                      />
                    </FormField>
                  )}
                  <FormField
                    label="Experience details"
                    className="sm:col-span-2"
                    error={errors['experience.items.' + i + '.description']}
                  >
                    <Textarea
                      rows={2}
                      value={row.description}
                      onChange={(e) => update({ description: e.target.value })}
                    />
                  </FormField>
                </div>
              )}
            />
          )}
        </fieldset>
        <fieldset className="border-border grid min-w-0 gap-4 border-t pt-5">
          <legend className="text-fg pt-5 font-semibold">
            What job is the applicant looking for?
          </legend>
          <p className="text-fg-muted text-sm">
            Select up to 10 relevant job categories. Leave unselected if not yet known.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            {categories.map((c) => (
              <Checkbox
                key={c.value}
                label={c.label}
                checked={wantedCategories.includes(c.value)}
                disabled={!wantedCategories.includes(c.value) && wantedCategories.length >= 10}
                onCheckedChange={(v) =>
                  setWantedCategories((current) =>
                    v === true
                      ? [...new Set([...current, c.value])]
                      : current.filter((code) => code !== c.value),
                  )
                }
              />
            ))}
          </div>
          {!categories.length && (
            <p className="text-fg-muted text-sm">No active job categories are available.</p>
          )}
          {Object.entries(errors)
            .filter(([key]) => key.startsWith('preferences.'))
            .map(([key, message]) => (
              <p key={key} role="alert" className="text-danger text-sm">
                {message}
              </p>
            ))}
        </fieldset>
        <FormField label="Applicant consent" required error={errors.consent}>
          <Checkbox
            label="The applicant has given consent"
            description={WALK_IN_CONSENT_NOTICE}
            checked={consent}
            onCheckedChange={(v) => {
              setConsent(v === true);
              setAlert(null);
              setErrors((current) => {
                const next = { ...current };
                delete next.consent;
                return next;
              });
            }}
          />
        </FormField>
      </fieldset>
      {alert && (
        <p role="alert" className="bg-danger-soft text-danger-soft-fg rounded-lg px-4 py-3 text-sm">
          {alert}
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        <Button type="submit" loading={pending} disabled={busy || matches.length > 0}>
          Register job seeker
        </Button>
        <Button variant="secondary" asChild>
          <Link href={basePath} variant="unstyled">
            Back to applicants
          </Link>
        </Button>
      </div>
    </form>
  );
}
