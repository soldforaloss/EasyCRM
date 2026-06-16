import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { renderMerge } from "../lib/merge";
import type { MergeVars } from "../lib/crm/types";
import type { Channel } from "../lib/crm/constants";

export interface ComposeTemplate {
  id: string;
  name: string;
  channel: string;
  subject: string | null;
  body: string;
}

export interface ComposeProps {
  /** Heading describing who/what is being messaged. */
  heading: string;
  /** Whether email can be sent (recipient has an email). */
  canEmail: boolean;
  /** Whether SMS can be sent (recipient has a phone). */
  canSms: boolean;
  /** Merge vars for the live preview (the recipient, or a representative recipient for bulk). */
  previewVars: MergeVars;
  templates: ComposeTemplate[];
  /** Hidden fields appended to the submission (e.g. contactId, or selected ids / segmentId). */
  hiddenFields?: Record<string, string | string[]>;
  /** The action intent value to submit. */
  actionValue: string;
  /** Optional note shown above the form (e.g. recipient count for bulk). */
  note?: string;
  /** Submit button label. */
  submitLabel?: string;
}

/**
 * Channel + template + compose form with a live, server-vars merge preview. Submits via a
 * fetcher to the current route's action. Used for single (contact) and bulk sends.
 */
export function ComposeMessage(props: ComposeProps) {
  const fetcher = useFetcher<{ ok: boolean; toast?: string }>();
  const [channel, setChannel] = useState<Channel>(props.canEmail ? "EMAIL" : "SMS");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const lastToast = useRef<string | null>(null);

  // Surface send results as a small inline banner (the parent page also shows toasts).
  const result = fetcher.data;
  useEffect(() => {
    if (result?.toast) lastToast.current = result.toast;
  }, [result]);

  const channelTemplates = props.templates.filter((t) => t.channel === channel);
  const subjectPreview = renderMerge(subject, props.previewVars);
  const bodyPreview = renderMerge(body, props.previewVars);
  const missing = [...new Set([...subjectPreview.missing, ...bodyPreview.missing])];

  function useTemplate(t: ComposeTemplate) {
    setChannel(t.channel === "SMS" ? "SMS" : "EMAIL");
    setSubject(t.subject ?? "");
    setBody(t.body);
  }

  function send() {
    const fd = new FormData();
    fd.set("_action", props.actionValue);
    fd.set("channel", channel);
    if (channel === "EMAIL") fd.set("subject", subject);
    fd.set("body", body);
    for (const [k, v] of Object.entries(props.hiddenFields ?? {})) {
      if (Array.isArray(v)) v.forEach((item) => fd.append(k, item));
      else fd.set(k, v);
    }
    fetcher.submit(fd, { method: "post" });
  }

  const channelUnavailable =
    (channel === "EMAIL" && !props.canEmail) || (channel === "SMS" && !props.canSms);
  const sending = fetcher.state !== "idle";

  return (
    <s-stack direction="block" gap="base">
      {props.note && <s-text color="subdued">{props.note}</s-text>}

      <s-select
        name="channel"
        label="Channel"
        value={channel}
        onChange={(event) =>
          setChannel(
            (event.target as HTMLSelectElement | null)?.value === "SMS" ? "SMS" : "EMAIL",
          )
        }
      >
        <s-option value="EMAIL" {...(props.canEmail ? {} : { disabled: true })}>
          Email
        </s-option>
        <s-option value="SMS" {...(props.canSms ? {} : { disabled: true })}>
          SMS
        </s-option>
      </s-select>

      {channelTemplates.length > 0 && (
        <s-stack direction="block" gap="small-300">
          <s-text color="subdued">Start from a template:</s-text>
          <s-stack direction="inline" gap="small-200">
            {channelTemplates.map((t) => (
              <s-button key={t.id} variant="tertiary" onClick={() => useTemplate(t)}>
                {t.name}
              </s-button>
            ))}
          </s-stack>
        </s-stack>
      )}

      {channel === "EMAIL" && (
        <s-text-field
          label="Subject"
          value={subject}
          onInput={(event) =>
            setSubject((event.target as HTMLInputElement | null)?.value ?? "")
          }
          placeholder="Thanks for your order, {{firstName}}!"
        />
      )}

      <s-text-area
        label="Message"
        value={body}
        rows={5}
        onInput={(event) =>
          setBody((event.target as HTMLTextAreaElement | null)?.value ?? "")
        }
        placeholder="Hi {{firstName}}, …"
      />

      {/* Live merge preview */}
      <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
        <s-stack direction="block" gap="small-300">
          <s-text type="strong">Preview</s-text>
          {channel === "EMAIL" && (
            <s-text>
              <s-text type="strong">Subject: </s-text>
              {subjectPreview.text || "(empty)"}
            </s-text>
          )}
          <s-text>{bodyPreview.text || "(empty)"}</s-text>
          {missing.length > 0 && (
            <s-text color="subdued">
              Note: these variables are empty for this preview: {missing.join(", ")}
            </s-text>
          )}
        </s-stack>
      </s-box>

      {channelUnavailable && (
        <s-banner tone="warning">
          <s-paragraph>
            {channel === "EMAIL"
              ? "This recipient has no email address."
              : "This recipient has no valid mobile number."}
          </s-paragraph>
        </s-banner>
      )}

      <s-button
        variant="primary"
        onClick={send}
        {...(sending || channelUnavailable || !body.trim() ? { disabled: true } : {})}
        {...(sending ? { loading: true } : {})}
      >
        {props.submitLabel ?? "Send message"}
      </s-button>

      {result?.toast && (
        <s-banner tone={result.ok ? "success" : "critical"}>
          <s-paragraph>{result.toast}</s-paragraph>
        </s-banner>
      )}
    </s-stack>
  );
}
