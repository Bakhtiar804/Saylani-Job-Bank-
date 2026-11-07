import { redirect } from 'next/navigation';
import { requireRole } from '@/domains/auth';
import { listBranches } from '@/domains/branch';
import { listMasterData } from '@/domains/settings';
import { hasPermission } from '@/domains/shared/scope';
import { WalkInForm } from './WalkInForm';

export async function WalkInPage({ role }: { role: 'STAFF' | 'BRANCH_ADMIN' }) {
  const { actor } = await requireRole(role);
  if (!hasPermission(actor, 'applicant:manage')) redirect('/forbidden');
  const branches = (await listBranches(actor))
    .filter((b) => b.isActive && actor.branchIds.includes(b.id))
    .map((b) => ({ id: b.id, name: b.name }));
  const categories = (await listMasterData(actor, { type: 'JOB_CATEGORY' })).map((c) => ({
    value: c.code,
    label: c.label,
  }));
  const basePath = role === 'STAFF' ? '/staff/applicants' : '/branch-admin/applicants';
  return (
    <div className="grid w-full gap-6">
      <header className="grid gap-1">
        <h1 className="text-fg text-2xl font-semibold">Add Walk-in Job Seeker</h1>
        <p className="text-fg-muted text-sm">
          Enter the applicant’s information manually. No email, smartphone, login or resume is
          needed.
        </p>
      </header>
      {branches.length ? (
        <WalkInForm branches={branches} basePath={basePath} categories={categories} />
      ) : (
        <p role="alert" className="text-danger">
          No active assigned branch is available. Contact your administrator.
        </p>
      )}
    </div>
  );
}
