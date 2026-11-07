import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/api/client';
import { WalkInForm } from './WalkInForm';
vi.mock('@/lib/api/client', () => ({ apiFetch: vi.fn(), ApiClientError: class extends Error {} }));
beforeEach(() => vi.mocked(apiFetch).mockReset());
it('submits entered experience and desired work through the existing registration contract without email or resume', async () => {
  vi.mocked(apiFetch)
    .mockResolvedValueOnce({ data: [] } as never)
    .mockResolvedValueOnce({
      data: { id: 'saved-reference', registrationSource: 'STAFF_ASSISTED' },
    } as never);
  const user = userEvent.setup();
  const { container } = render(
    <WalkInForm
      branches={[{ id: 'branch', name: 'Karachi' }]}
      basePath="/staff/applicants"
      categories={[{ value: 'RETAIL', label: 'Retail' }]}
    />,
  );
  expect(
    container.querySelector('input[type=email],input[type=file],input[type=password]'),
  ).toBeNull();
  await user.type(screen.getByLabelText(/CNIC number/), '4210112345671');
  await user.click(screen.getByRole('button', { name: 'Check existing applicant' }));
  await screen.findByText(/No matching applicant is visible/);
  await user.type(screen.getByLabelText(/^Full name/), 'Manual Applicant');
  await user.type(screen.getByLabelText(/husband/), 'Parent Name');
  await user.type(screen.getByLabelText(/Date of birth/), '1995-01-01');
  await user.selectOptions(screen.getByLabelText(/^Gender/), 'MALE');
  await user.click(screen.getByRole('button', { name: 'Add work experience' }));
  const job = within(screen.getByRole('group', { name: 'Previous job 1' }));
  await user.type(job.getByLabelText(/Employer/), 'Local Shop');
  await user.type(job.getByLabelText(/Job title/), 'Shop Assistant');
  await user.selectOptions(job.getByLabelText(/Experience related to/), 'RETAIL');
  await user.click(job.getByRole('checkbox', { name: 'Currently working here' }));
  const selects = job.getAllByRole('combobox');
  await user.selectOptions(selects[1]!, '01');
  await user.selectOptions(selects[2]!, '2020');
  await user.type(job.getByLabelText('Experience details'), 'Customer service and stock handling');
  await user.click(screen.getByRole('checkbox', { name: 'Retail' }));
  await user.click(screen.getByText('The applicant has given consent', { exact: true }));
  await user.click(screen.getByRole('button', { name: 'Register job seeker' }));
  await screen.findByRole('heading', { name: 'Job seeker registered' });
  expect(apiFetch).toHaveBeenLastCalledWith(
    '/api/v1/applicants/staff-register',
    expect.objectContaining({
      body: expect.objectContaining({
        experience: {
          hasNoExperience: false,
          items: [
            expect.objectContaining({
              employerName: 'Local Shop',
              jobTitle: 'Shop Assistant',
              categoryCode: 'RETAIL',
              startMonth: '2020-01',
              endMonth: null,
              isCurrent: true,
            }),
          ],
        },
        preferences: expect.objectContaining({ categoryCodes: ['RETAIL'] }),
      }),
    }),
  );
  await user.click(screen.getByRole('button', { name: 'Add another job seeker' }));
  expect(screen.getByRole('checkbox', { name: 'Retail' })).not.toBeChecked();
  expect(screen.queryByRole('group', { name: 'Previous job 1' })).toBeNull();
});
