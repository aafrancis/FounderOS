import { PageHeader } from '@/components/PageHeader';
import { ApprovalsPanel } from '@/components/approvals/ApprovalsPanel';

export const dynamic = 'force-dynamic';

/**
 * Approvals (SH-0271): the one queue every send, spend and publish action goes
 * through. Classic tree only. Nothing here acts by itself: each button is the
 * operator's decision, and every rule is enforced by the routes under /api/approvals.
 */
export default function ApprovalsPage() {
  return (
    <div>
      <PageHeader eyebrow="Send, spend and publish only run after you approve them" title="Approvals" />
      <ApprovalsPanel />
    </div>
  );
}
