import { Form } from "react-router";
import type { IconName } from "../lib/crm/constants";

export interface ConfirmActionProps {
  /** Unique modal id (must be unique on the page). */
  id: string;
  /** Trigger button label (omit when using only an icon). */
  triggerLabel?: string;
  triggerIcon?: IconName;
  triggerAccessibilityLabel?: string;
  heading: string;
  message: string;
  confirmLabel: string;
  /** Hidden form fields submitted on confirm (include `_action`). */
  fields: Record<string, string>;
}

/**
 * A destructive-action button that opens a Polaris confirmation modal. The confirm button
 * submits a POST Form (to the current route's action) and closes the modal; cancel just closes.
 * Uses the native invoker command/commandFor pattern (no event wiring needed).
 */
export function ConfirmAction(props: ConfirmActionProps) {
  return (
    <>
      <s-button
        variant="tertiary"
        tone="critical"
        command="--show"
        commandFor={props.id}
        {...(props.triggerIcon ? { icon: props.triggerIcon } : {})}
        {...(props.triggerAccessibilityLabel
          ? { accessibilityLabel: props.triggerAccessibilityLabel }
          : {})}
      >
        {props.triggerLabel}
      </s-button>
      <s-modal id={props.id} heading={props.heading} size="small">
        <Form method="post">
          {Object.entries(props.fields).map(([k, v]) => (
            <input key={k} type="hidden" name={k} value={v} />
          ))}
          <s-stack direction="block" gap="base">
            <s-text>{props.message}</s-text>
            <s-text tone="caution">This action cannot be undone.</s-text>
          </s-stack>
          <s-button
            slot="primary-action"
            type="submit"
            variant="primary"
            tone="critical"
            command="--hide"
            commandFor={props.id}
          >
            {props.confirmLabel}
          </s-button>
          <s-button
            slot="secondary-actions"
            variant="secondary"
            command="--hide"
            commandFor={props.id}
          >
            Cancel
          </s-button>
        </Form>
      </s-modal>
    </>
  );
}
