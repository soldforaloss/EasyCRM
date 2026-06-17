/** Small reusable Polaris-badge components for CRM enums. */

import {
  CHANNEL_META,
  LIFECYCLE_STAGE_META,
  MESSAGE_STATUS_META,
  TASK_STATUS_META,
  isChannel,
  isLifecycleStage,
  isMessageStatus,
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

export function MessageStatusBadge({ status }: { status: string }) {
  if (!isMessageStatus(status)) return <s-badge>{status}</s-badge>;
  const meta = MESSAGE_STATUS_META[status];
  return <s-badge tone={meta.tone}>{meta.label}</s-badge>;
}

export function ChannelBadge({ channel }: { channel: string }) {
  if (!isChannel(channel)) return <s-badge>{channel}</s-badge>;
  return <s-badge tone="neutral">{CHANNEL_META[channel].label}</s-badge>;
}
