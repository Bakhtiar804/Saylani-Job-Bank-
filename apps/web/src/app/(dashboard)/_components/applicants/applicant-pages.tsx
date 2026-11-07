import type { Role } from '@jobbank/shared';
import { Button, Link, StatusPill } from '@/components/atoms';
import { DetailPageLayout } from '@/components/templates';
import {
  APPLICANT_SORTABLE,
  applicantFilters,
  getApplicantForStaff,
  listApplicants,
  listApplicantCreators,
} from '@/domains/applicant';
import { requireRole } from '@/domains/auth';
import { listBranches, listBranchOptions } from '@/domains/branch';
import { listApplicationsForApplicant } from '@/domains/placement';
import { listMasterData } from '@/domains/settings';
import { ValidationError } from '@/domains/shared/errors';
import { parseListQuery } from '@/domains/shared/pagination';
import { cityScope, hasPermission, isSuperAdmin } from '@/domains/shared/scope';
import { db } from '@/lib/db';
import { schema } from '@jobbank/db';
import { and, eq, sql } from 'drizzle-orm';
import { loadForPage } from '../../_lib/page-context';
import { ApplicantDetailView } from './ApplicantDetailView';
import { ApplicantsTable } from './ApplicantsTable';
import { APPLICANT_STATUS_PILL } from './labels';
import { profileLabels } from './lists';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const listOptions = {
  sortable: APPLICANT_SORTABLE,
  defaultSort: { field: 'createdAt' as const, direction: 'desc' as const },
  filters: applicantFilters,
};

/** Branch-scoped applicant search; filters live in the URL so views can be shared. */
export async function ApplicantListPage({
  role,
  searchParams,
}: {
  role: Role;
  searchParams: SearchParams;
}) {
  const { actor } = await requireRole(role);
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    if (typeof value === 'string' && value) params.set(key, value);
  }
  let query;
  try {
    query = parseListQuery(params, listOptions);
  } catch (error) {
    // A hand-edited URL with bad filters falls back to the default view.
    if (!(error instanceof ValidationError)) throw error;
    query = parseListQuery(new URLSearchParams(), listOptions);
  }
  const [{ data, meta }, branches, skills, creators] = await Promise.all([
    loadForPage(actor, () => listApplicants(actor, query)),
    listBranches(actor),
    listMasterData(actor, { type: 'SKILL' }),
    listApplicantCreators(actor),
  ]);

  return (
    <div className="grid w-full gap-6">
      <header className="grid gap-1">
        <h1 className="text-fg text-2xl font-semibold">Applicants</h1>
        <p className="text-fg-muted text-sm">
          {isSuperAdmin(actor) && !actor.activeBranchId
            ? 'Job seekers across all branches. Use the branch switcher to focus on one branch.'
            : 'Job seekers registered with your branch.'}
        </p>
        {(role === 'STAFF' || role === 'BRANCH_ADMIN') &&
          hasPermission(actor, 'applicant:manage') && (
            <div className="mt-3">
              <Button asChild>
                <Link
                  href={role === 'STAFF' ? '/staff/applicants/new' : '/branch-admin/applicants/new'}
                  variant="unstyled"
                >
                  Add Walk-in Job Seeker
                </Link>
              </Button>
            </div>
          )}
      </header>
      <ApplicantsTable
        creators={creators.map((c) => ({ value: c.id, label: c.name }))}
        rows={data}
        meta={meta}
        sort={{ id: query.sort.field, direction: query.sort.direction }}
        branches={branches.map((b) => ({ value: b.id, label: b.name }))}
        skills={skills.map((s) => ({ value: s.code, label: s.label }))}
      />
    </div>
  );
}

export async function ApplicantDetailPage({
  role,
  basePath,
  params,
}: {
  role: Role;
  basePath: string;
  params: Promise<{ id: string }>;
}) {
  const { actor } = await requireRole(role);
  const { id } = await params;
  const applicant = await loadForPage(actor, () => getApplicantForStaff(actor, id));

  // Fetch open jobs in the applicant's city for the shortlist picker
  const openJobsPromise =
    applicant.can.shortlist && applicant.address?.cityCode
      ? db
          .select({
            id: schema.jobs.id,
            title: schema.jobs.title,
            companyId: schema.jobs.companyId,
          })
          .from(schema.jobs)
          .innerJoin(schema.jobLocations, eq(schema.jobs.id, schema.jobLocations.jobId))
          .where(
            and(
              cityScope(actor, schema.jobs.branchId),
              eq(schema.jobs.status, 'OPEN'),
              sql`upper(${schema.jobLocations.cityCode}) = upper(${applicant.address.cityCode})`,
            ),
          )
          .limit(100)
          .then((rows) => rows.map((r) => ({ value: r.id, label: r.title })))
      : Promise.resolve([]);

  const [labels, branches, openJobs, existingApplications] = await Promise.all([
    profileLabels(),
    applicant.can.transfer
      ? listBranchOptions(applicant.address?.location ?? { lat: 30.3753, lng: 69.3451 })
      : Promise.resolve([]),
    openJobsPromise,
    hasPermission(actor, 'match_case:read')
      ? listApplicationsForApplicant(actor, applicant.id)
      : Promise.resolve([]),
  ]);

  return (
    <DetailPageLayout
      breadcrumbs={[
        { label: 'Applicants', href: basePath },
        { label: applicant.personal.fullName },
      ]}
      title={applicant.personal.fullName}
      subtitle={
        [applicant.branch?.name, `${applicant.completeness.percent}% complete`]
          .filter(Boolean)
          .join(' · ') || undefined
      }
      status={<StatusPill {...APPLICANT_STATUS_PILL[applicant.status]} />}
    >
      <ApplicantDetailView
        applicant={applicant}
        labels={labels}
        branches={branches.map((b) => ({ value: b.id, label: b.name }))}
        openJobs={openJobs}
        existingApplications={existingApplications}
        listPath={basePath}
      />
    </DetailPageLayout>
  );
}
