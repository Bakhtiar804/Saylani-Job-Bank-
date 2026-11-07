'use client';
import { useEffect, useState } from 'react';
import { Button } from '@/components/atoms';
import { apiFetch } from '@/lib/api/client';
const labels: Record<string, string> = {
  PROFILE_OR_JOB_NOT_READY: 'The profile must be active and the job open.',
  NOT_RUN: 'No matching run recorded for this job.',
  PENDING: 'A matching request is recorded as pending.',
  RUNNING: 'The latest recorded matching run is running.',
  FAILED: 'The last matching run failed.',
  STALE: 'Matching results are stale. A fresh run is required.',
  ELIGIBLE_RECORDED_MATCH: 'A current eligible match is recorded.',
  NO_ELIGIBLE_RECORDED_MATCH: 'No current eligible match is recorded for this applicant.',
};
export function AssistedMatchCheck({
  applicantId,
  jobId,
  onChange,
}: {
  applicantId: string;
  jobId: string;
  onChange: (eligible: boolean) => void;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState('Checking recorded matching status…');
  useEffect(() => {
    const controller = new AbortController();
    onChange(false);
    setMessage('Checking recorded matching status…');
    apiFetch<{ status: string; eligible: boolean; jobTitle: string }>(
      '/api/v1/applications?' + new URLSearchParams({ applicantId, jobId }),
      { signal: controller.signal },
    )
      .then(({ data }) => {
        if (controller.signal.aborted) return;
        setMessage(
          `${data.jobTitle}: ${labels[data.status] ?? 'Matching state is not available.'}`,
        );
        onChange(data.eligible);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setMessage('Matching status could not be checked. Submission is unavailable.');
          onChange(false);
        }
      });
    return () => controller.abort();
  }, [applicantId, jobId, onChange]);
  return (
    <div className="bg-surface-muted text-fg-muted grid gap-2 rounded-lg p-3 text-sm">
      <p role="status">{message}</p>
      <Button
        variant="secondary"
        size="sm"
        loading={refreshing}
        onClick={async () => {
          setRefreshing(true);
          onChange(false);
          try {
            await apiFetch('/api/v1/jobs/' + jobId + '/matches/refresh', { method: 'POST' });
            setMessage(
              'Matching refresh queued. Completion is not confirmed; close and reopen this dialog later to check stored results.',
            );
          } catch {
            setMessage(
              'Matching refresh could not be requested. Your current permissions may not allow refreshing this job.',
            );
          } finally {
            setRefreshing(false);
          }
        }}
      >
        Request matching refresh
      </Button>
      <p>Live matching worker availability is not checked. This shows stored results only.</p>
    </div>
  );
}
