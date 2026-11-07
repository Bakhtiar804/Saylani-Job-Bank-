import { z } from 'zod';
import {
  getAssistedApplicationStatus,
  shortlistApplicant,
  shortlistSchema,
} from '@/domains/placement';
import { apiHandler, created, ok } from '@/domains/shared/http';

/** POST /api/v1/applications — staff/branch-admin shortlist an applicant for an open job. */
export const POST = apiHandler({
  permission: 'match_case:manage',
  body: shortlistSchema,
  handler: async ({ ctx, actor, body }) =>
    created(await shortlistApplicant({ ...ctx, actor: actor! }, body)),
});

export const GET = apiHandler({
  permission: 'match_case:manage',
  query: z.object({ applicantId: z.uuid(), jobId: z.uuid() }),
  handler: async ({ actor, query }) =>
    ok(await getAssistedApplicationStatus(actor!, query.applicantId, query.jobId)),
});
