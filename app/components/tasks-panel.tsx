import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { formatDate } from "../lib/format";
import { useActionToast } from "../lib/use-action-toast";
import { TaskStatusBadge } from "./badges";

export interface TaskItem {
  id: string;
  title: string;
  status: string;
  dueAt: Date | string | null;
}

const ADD_MODAL_ID = "add-task-modal";

/**
 * Tasks panel: add via a modal (gives the date picker room to open without being clipped) and
 * toggle status inline. Submits via a fetcher with controlled values — native <Form> submits don't
 * reliably capture Polaris field values.
 */
export function TasksPanel({ tasks }: { tasks: TaskItem[] }) {
  const fetcher = useFetcher<{ ok: boolean; toast?: string }>();
  const [title, setTitle] = useState("");
  const [dueAt, setDueAt] = useState("");
  const busy = fetcher.state !== "idle";
  const wasBusy = useRef(false);

  useActionToast(fetcher.data);

  useEffect(() => {
    if (wasBusy.current && fetcher.state === "idle" && fetcher.data?.ok) {
      setTitle("");
      setDueAt("");
    }
    wasBusy.current = fetcher.state !== "idle";
  }, [fetcher.state, fetcher.data]);

  function addTask() {
    const value = title.trim();
    if (!value) return;
    fetcher.submit({ _action: "createTask", title: value, dueAt }, { method: "post" });
  }

  function toggle(task: TaskItem) {
    fetcher.submit(
      { _action: "toggleTask", taskId: task.id, status: task.status === "DONE" ? "OPEN" : "DONE" },
      { method: "post" },
    );
  }

  return (
    <s-stack direction="block" gap="base">
      <s-button command="--show" commandFor={ADD_MODAL_ID} variant="primary">
        Add task
      </s-button>

      {tasks.length === 0 ? (
        <s-stack direction="block" alignItems="center">
          <s-text color="subdued">No tasks for this contact.</s-text>
        </s-stack>
      ) : (
        <s-stack direction="block" gap="small-200">
          {tasks.map((task) => (
            <s-box key={task.id} padding="small-200" borderRadius="base" background="subdued">
              <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
                <s-stack direction="inline" gap="base" alignItems="center">
                  <TaskStatusBadge status={task.status} />
                  <s-stack direction="block" gap="small-500">
                    <s-text type="strong">{task.title}</s-text>
                    {task.dueAt ? <s-text color="subdued">Due {formatDate(task.dueAt)}</s-text> : null}
                  </s-stack>
                </s-stack>
                <s-button
                  variant="tertiary"
                  onClick={() => toggle(task)}
                  {...(busy ? { disabled: true } : {})}
                >
                  {task.status === "DONE" ? "Reopen" : "Mark done"}
                </s-button>
              </s-stack>
            </s-box>
          ))}
        </s-stack>
      )}

      <s-modal id={ADD_MODAL_ID} heading="Add task">
        <s-stack direction="block" gap="base">
          <s-text-field
            label="New task"
            placeholder="Follow up…"
            value={title}
            onInput={(event) => setTitle((event.target as HTMLInputElement | null)?.value ?? "")}
          />
          <s-date-field
            label="Due date"
            value={dueAt}
            onChange={(event) => setDueAt((event.target as HTMLInputElement | null)?.value ?? "")}
          />
        </s-stack>
        <s-button
          slot="primary-action"
          variant="primary"
          command="--hide"
          commandFor={ADD_MODAL_ID}
          onClick={addTask}
          {...(!title.trim() ? { disabled: true } : {})}
        >
          Add task
        </s-button>
        <s-button slot="secondary-actions" variant="secondary" command="--hide" commandFor={ADD_MODAL_ID}>
          Cancel
        </s-button>
      </s-modal>
    </s-stack>
  );
}
