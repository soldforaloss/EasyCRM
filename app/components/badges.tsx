/** Small reusable Polaris-badge components for CRM enums. */

import {
  LIFECYCLE_STAGE_META,
  TASK_STATUS_META,
  isLifecycleStage,
  isTaskStatus,
} from "../lib/crm/constants";

export function StageBadge({ stage }: { stage: string }) {
  if (!isLifecycleStage(stage)) return <s-badge>{stage}</s-badge>;
  const meta = LIFECYCLE_STAGE_META[stage];
  return (
    <s-badge tone={meta.tone} {...(meta.color ? { color: meta.color } : {})}>
      {meta.label}
    </s-badge>
  );
}

export function TaskStatusBadge({ status }: { status: string }) {
  if (!isTaskStatus(status)) return <s-badge>{status}</s-badge>;
  const meta = TASK_STATUS_META[status];
  return <s-badge tone={meta.tone}>{meta.label}</s-badge>;
}
