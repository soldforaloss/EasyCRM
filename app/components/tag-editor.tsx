import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { useActionToast } from "../lib/use-action-toast";

export interface TagItem {
  id: string;
  name: string;
}

/**
 * Add/remove contact tags. Submits via a fetcher with values read from controlled state — Polaris
 * web-component fields don't reliably serialize into a native <Form> submit, so we never depend on
 * that (see the easy-crm Polaris gotchas).
 */
export function TagEditor({ tags }: { tags: TagItem[] }) {
  const fetcher = useFetcher<{ ok: boolean; toast?: string }>();
  const [name, setName] = useState("");
  const busy = fetcher.state !== "idle";
  const wasBusy = useRef(false);

  useActionToast(fetcher.data);

  // Clear the input once an add round-trip completes successfully.
  useEffect(() => {
    if (wasBusy.current && fetcher.state === "idle" && fetcher.data?.ok) setName("");
    wasBusy.current = fetcher.state !== "idle";
  }, [fetcher.state, fetcher.data]);

  function addTag() {
    const value = name.trim();
    if (!value) return;
    fetcher.submit({ _action: "addTag", tagName: value }, { method: "post" });
  }

  function removeTag(tagId: string) {
    fetcher.submit({ _action: "removeTag", tagId }, { method: "post" });
  }

  return (
    <s-stack direction="block" gap="base">
      {tags.length === 0 ? (
        <s-stack direction="block" alignItems="center">
          <s-text color="subdued">No tags yet.</s-text>
        </s-stack>
      ) : (
        <s-stack direction="inline" gap="small-200">
          {tags.map((tag) => (
            <s-button
              key={tag.id}
              variant="tertiary"
              icon="x"
              onClick={() => removeTag(tag.id)}
              {...(busy ? { disabled: true } : {})}
            >
              {tag.name}
            </s-button>
          ))}
        </s-stack>
      )}

      <s-stack direction="block" gap="small-200">
        <s-text-field
          label="Add tag"
          placeholder="e.g. VIP"
          value={name}
          onInput={(event) =>
            setName((event.target as HTMLInputElement | null)?.value ?? "")
          }
        />
        <s-button
          variant="primary"
          onClick={addTag}
          {...(busy || !name.trim() ? { disabled: true } : {})}
          {...(busy ? { loading: true } : {})}
        >
          Add tag
        </s-button>
      </s-stack>
    </s-stack>
  );
}
