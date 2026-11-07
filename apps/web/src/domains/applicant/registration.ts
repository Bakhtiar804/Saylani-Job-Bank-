import 'server-only';
import { schema } from '@jobbank/db';
import {
  staffRegisterApplicantSchema,
  WALK_IN_CONSENT_NOTICE,
  WALK_IN_CONSENT_VERSION,
  type StaffRegisterApplicantInput,
} from '@jobbank/shared';
import { eq } from 'drizzle-orm';
import { assertActiveMasterData, resolveMatchRadius } from '@/domains/settings';
import { runCommand } from '@/domains/shared/audit';
import {
  ConflictError,
  ForbiddenError,
  isUniqueViolation,
  ValidationError,
} from '@/domains/shared/errors';
import { assertBranchAccess, assertPermission, assertRole } from '@/domains/shared/scope';
import { normalizePkMobile } from '@/lib/format/phone';
import {
  a,
  addr,
  edu,
  exp,
  skl,
  lng,
  cert,
  pref,
  cnicOwner,
  fromMonth,
  refreshProfileState,
  type SignedIn,
} from './repository';

/** Dedicated staff operation: never impersonates the applicant or creates login credentials. */
export async function staffRegisterApplicant(ctx: SignedIn, raw: StaffRegisterApplicantInput) {
  assertRole(ctx.actor, 'STAFF', 'BRANCH_ADMIN');
  assertPermission(ctx.actor, 'applicant:manage');
  if (ctx.actor.twoFactorPending)
    throw new ForbiddenError('Set up two-factor authentication to continue');
  const input = staffRegisterApplicantSchema.parse(raw);
  const branchId =
    input.branchId ?? (ctx.actor.branchIds.length === 1 ? ctx.actor.branchIds[0] : undefined);
  if (!branchId)
    throw new ValidationError([{ path: 'branchId', message: 'Choose an assigned branch' }]);
  assertBranchAccess(ctx.actor, branchId);
  // Unlike the UI phone formatter, reject overlong input rather than truncating it.
  const digits = input.contactPhone?.replace(/\D/g, '') ?? '';
  const phone = input.contactPhone ? normalizePkMobile(input.contactPhone) : null;
  if (input.contactPhone && (!phone || !/^(?:03\d{9}|3\d{9}|923\d{9}|00923\d{9})$/.test(digits))) {
    throw new ValidationError([
      { path: 'contactPhone', message: 'Enter a Pakistani mobile contact number' },
    ]);
  }
  try {
    return await runCommand(ctx, async (cmd) => {
      const { tx, audit } = cmd;
      const [branch] = await tx
        .select()
        .from(schema.branches)
        .where(eq(schema.branches.id, branchId))
        .for('share');
      if (!branch?.isActive)
        throw new ValidationError([
          { path: 'branchId', message: 'Choose an active assigned branch' },
        ]);
      if (await cnicOwner(tx, input.cnic))
        throw new ConflictError('This CNIC is already registered', { reason: 'CNIC_TAKEN' });
      const [row] = await tx
        .insert(a)
        .values({
          userId: null,
          branchId,
          registeredByUserId: ctx.actor.userId,
          registrationBranchId: branchId,
          registrationSource: 'STAFF_ASSISTED',
          fullName: input.fullName,
          fatherName: input.fatherName,
          cnic: input.cnic,
          dateOfBirth: input.dateOfBirth,
          gender: input.gender,
          email: input.email ?? null,
          contactPhone: phone,
          hasNoExperience: input.experience?.hasNoExperience ?? false,
        })
        .returning();
      const id = row!.id;
      if (input.location) {
        const location = input.location;
        const city = (
          await assertActiveMasterData(tx, 'CITY', [location.cityCode], () => 'location.cityCode')
        ).get(location.cityCode)!;
        if (location.areaCode) {
          const area = (
            await assertActiveMasterData(tx, 'AREA', [location.areaCode], () => 'location.areaCode')
          ).get(location.areaCode)!;
          if (area.parentId !== city.id)
            throw new ValidationError([
              { path: 'location.areaCode', message: 'This area is not in the selected city' },
            ]);
        }
        await tx
          .insert(addr)
          .values({ ...location, applicantId: id, addressLine: location.addressLine ?? '' });
      }
      if (input.education) {
        await assertActiveMasterData(
          tx,
          'EDUCATION_LEVEL',
          input.education.items.map((i) => i.levelCode),
          (i) => `education.items.${i}.levelCode`,
        );
        if (input.education.items.length)
          await tx
            .insert(edu)
            .values(
              input.education.items.map((i, sortOrder) => ({ ...i, applicantId: id, sortOrder })),
            );
      }
      if (input.experience) {
        const categories = input.experience.items.flatMap((i, n) =>
          i.categoryCode ? [{ code: i.categoryCode, n }] : [],
        );
        await assertActiveMasterData(
          tx,
          'JOB_CATEGORY',
          categories.map((i) => i.code),
          (n) => `experience.items.${categories[n]!.n}.categoryCode`,
        );
        if (input.experience.items.length)
          await tx.insert(exp).values(
            input.experience.items.map((i, sortOrder) => ({
              ...i,
              startMonth: fromMonth(i.startMonth)!,
              endMonth: fromMonth(i.endMonth),
              applicantId: id,
              sortOrder,
            })),
          );
      }
      if (input.skills?.items.length) {
        // Follow self-profile's existing custom skill convention.
        await tx
          .insert(schema.masterData)
          .values(
            input.skills.items.map((i) => ({
              type: 'SKILL' as const,
              code: i.skillCode,
              label: i.skillCode.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
              isActive: true,
            })),
          )
          .onConflictDoNothing();
        await tx.insert(skl).values(input.skills.items.map((i) => ({ ...i, applicantId: id })));
      }
      if (input.languages) {
        await assertActiveMasterData(
          tx,
          'LANGUAGE',
          input.languages.items.map((i) => i.languageCode),
          (i) => `languages.items.${i}.languageCode`,
        );
        if (input.languages.items.length)
          await tx
            .insert(lng)
            .values(input.languages.items.map((i) => ({ ...i, applicantId: id })));
      }
      if (input.certifications?.items.length)
        await tx.insert(cert).values(
          input.certifications.items.map((i, sortOrder) => ({
            ...i,
            issuedMonth: fromMonth(i.issuedMonth),
            expiresMonth: fromMonth(i.expiresMonth),
            applicantId: id,
            sortOrder,
          })),
        );
      if (input.preferences) {
        await assertActiveMasterData(
          tx,
          'JOB_CATEGORY',
          input.preferences.categoryCodes,
          (i) => `preferences.categoryCodes.${i}`,
        );
        const { maxM } = await resolveMatchRadius({ branchId });
        if (input.preferences.willingRadiusM !== null && input.preferences.willingRadiusM > maxM)
          throw new ValidationError([
            { path: 'preferences.willingRadiusM', message: 'Exceeds branch matching radius' },
          ]);
        await tx.insert(pref).values({ ...input.preferences, applicantId: id });
      }
      audit({
        action: 'applicant.staff_register',
        entityType: 'applicant',
        entityId: id,
        branchId,
        after: {
          registrationSource: 'STAFF_ASSISTED',
          registeredByUserId: ctx.actor.userId,
          registrationBranchId: branchId,
        },
        metadata: {
          consent: {
            accepted: true,
            version: WALK_IN_CONSENT_VERSION,
            notice: WALK_IN_CONSENT_NOTICE,
          },
        },
      });
      const state = await refreshProfileState(cmd, id);
      return {
        id,
        ...state,
        identityStatus: row!.identityStatus,
        registeredByUserId: row!.registeredByUserId,
        registrationBranchId: row!.registrationBranchId,
        registrationSource: row!.registrationSource,
        createdAt: row!.createdAt.toISOString(),
      };
    });
  } catch (error) {
    if (isUniqueViolation(error, 'applicants_cnic_unique'))
      throw new ConflictError('This CNIC is already registered', { reason: 'CNIC_TAKEN' });
    throw error;
  }
}
