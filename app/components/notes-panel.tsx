import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { formatDateTime } from "../lib/format";
import { useActionToast } from "../lib/use-action-toast";
import { ConfirmAction } from "./confirm";

export interface NoteItem {
  id: string;
  body: string;
  createdAt: Date | string;
}

const EDIT_MODAL_ID = "note-edit-modal";

/**
 * Notes panel: a compact composer plus read-only note cards. Editing happens in a modal so the
 * list stays scannable (no always-open textarea per note). Add/edit submit via a fetcher with
 * values from controlled state — native <Form> submits don't reliably capture Polaris field values.
 */
export function NotesPanel({ notes }: { notes: NoteItem[] }) {
  const fetcher = useFetcher<{ ok: boolean; toast?: string }>();
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const busy = fetcher.state !== "idle";
  const wasBusy = useRef(false);

  useActionToast(fetcher.data);

  useEffect(() => {
    if (wasBusy.current && fetcher.state === "idle" && fetcher.data?.ok) setDraft("");
    wasBusy.current = fetcher.state !== "idle";
  }, [fetcher.state, fetcher.data]);

  function addNote() {
    const body = draft.trim();
    if (!body) return;
    fetcher.submit({ _action: "addNote", body }, { method: "post" });
  }

  function saveEdit() {
    if (!editing) return;
    const body = editing.body.trim();
    if (!body) return;
    fetcher.submit({ _action: "editNote", noteId: editing.id, body }, { method: "post" });
  }

  return (
    <s-stack direction="block" gap="base">
      <s-stack direction="block" gap="small-200">
        <s-text-area
          label="Add a note"
          rows={3}
          value={draft}
          onInput={(event) =>
            setDraft((event.target as HTMLTextAreaElement | null)?.value ?? "")
          }
          placeholder="Log a call, a preference, a follow-up detail…"
        />
        <s-button
          variant="primary"
          onClick={addNote}
          {...(busy || !draft.trim() ? { disabled: true } : {})}
          {...(busy ? { loading: true } : {})}
        >
          Add note
        </s-button>
      </s-stack>

      {notes.length === 0 ? (
        <s-stack direction="block" alignItems="center">
          <s-text color="subdued">No notes yet.</s-text>
        </s-stack>
      ) : (
        <s-stack direction="block" gap="small-200">
          {notes.map((note) => (
            <s-box key={note.id} padding="base" borderWidth="base" borderRadius="base">
              <s-stack direction="block" gap="small-200">
                <s-text color="subdued">{formatDateTime(note.createdAt)}</s-text>
                <s-paragraph>{note.body}</s-paragraph>
                <s-stack direction="inline" gap="small-200" alignItems="center">
                  <s-button
                    variant="tertiary"
                    icon="edit"
                    command="--show"
                    commandFor={EDIT_MODAL_ID}
                    onClick={() => setEditing({ id: note.id, body: note.body })}
                  >
                    Edit
                  </s-button>
                  <ConfirmAction
                    id={`confirm-del-note-${note.id}`}
                    triggerLabel="Delete"
                    triggerIcon="delete"
                    heading="Delete note?"
                    message="This note will be permanently removed."
                    confirmLabel="Delete note"
                    fields={{ _action: "deleteNote", noteId: note.id }}
                  />
                </s-stack>
              </s-stack>
            </s-box>
          ))}
        </s-stack>
      )}

      <s-modal id={EDIT_MODAL_ID} heading="Edit note">
        <s-text-area
          label="Note"
          rows={5}
          value={editing?.body ?? ""}
          onInput={(event) =>
            setEditing((prev) =>
              prev
                ? { ...prev, body: (event.target as HTMLTextAreaElement | null)?.value ?? "" }
                : prev,
            )
          }
        />
        <s-button
          slot="primary-action"
          variant="primary"
          command="--hide"
          commandFor={EDIT_MODAL_ID}
          onClick={saveEdit}
          {...(!editing?.body.trim() ? { disabled: true } : {})}
        >
          Save
        </s-button>
        <s-button slot="secondary-actions" variant="secondary" command="--hide" commandFor={EDIT_MODAL_ID}>
          Cancel
        </s-button>
      </s-modal>
    </s-stack>
  );
}
