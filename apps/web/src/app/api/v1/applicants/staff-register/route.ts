import { staffRegisterApplicantSchema } from '@jobbank/shared';
import { staffRegisterApplicant } from '@/domains/applicant';
import { apiHandler, created } from '@/domains/shared/http';

/** Staff session + existing role/permission/2FA pipeline; no applicant authentication. */
export const POST = apiHandler({
  roles: ['STAFF', 'BRANCH_ADMIN'],
  permission: 'applicant:manage',
  idempotent: true,
  body: staffRegisterApplicantSchema,
  handler: async ({ ctx, actor, body }) => {
    const result = await staffRegisterApplicant({ ...ctx, actor: actor! }, body);
    return created(result, `/api/v1/applicants/${result.id}`);
  },
});
