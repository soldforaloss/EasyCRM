import { useFetcher } from "react-router";
import { LIFECYCLE_STAGES, LIFECYCLE_STAGE_META } from "../lib/crm/constants";
import { useActionToast } from "../lib/use-action-toast";

/**
 * Lifecycle-stage picker. Submits on change via a fetcher reading the select's value from the
 * event — native <Form> submits don't reliably capture Polaris field values.
 */
export function StageSelector({ value }: { value: string }) {
  const fetcher = useFetcher<{ ok: boolean; toast?: string }>();
  const busy = fetcher.state !== "idle";

  useActionToast(fetcher.data);

  // Optimistic value so the select reflects the choice immediately while the request is in flight.
  const current = (fetcher.formData?.get("stage") as string | null) ?? value;

  return (
    <s-select
      label="Change stage"
      value={current}
      onChange={(event) => {
        const next = (event.target as HTMLSelectElement | null)?.value;
        if (next && next !== value) {
          fetcher.submit({ _action: "setStage", stage: next }, { method: "post" });
        }
      }}
      {...(busy ? { disabled: true } : {})}
    >
      {LIFECYCLE_STAGES.map((stage) => (
        <s-option key={stage} value={stage}>
          {LIFECYCLE_STAGE_META[stage].label}
        </s-option>
      ))}
    </s-select>
  );
}
