import { useEffect, useRef } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  createTask,
  deleteTask,
  groupTasks,
  listTasks,
  setTaskStatus,
  type TaskWithContact,
} from "../lib/crm/tasks.server";
import { displayName, formatDate } from "../lib/format";
import { TaskStatusBadge } from "../components/badges";
import { ConfirmAction } from "../components/confirm";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const tasks = await listTasks(session.shop);
  const groups = groupTasks(tasks);
  const toView = (t: TaskWithContact) => ({
    id: t.id,
    title: t.title,
    notes: t.notes,
    status: t.status,
    dueAt: t.dueAt,
    contactId: t.contactId,
    contactName: t.contact
      ? displayName(t.contact.firstName, t.contact.lastName)
      : null,
  });
  return {
    overdue: groups.overdue.map(toView),
    today: groups.today.map(toView),
    upcoming: groups.upcoming.map(toView),
    noDueDate: groups.noDueDate.map(toView),
    done: groups.done.map(toView),
    openCount:
      groups.overdue.length +
      groups.today.length +
      groups.upcoming.length +
      groups.noDueDate.length,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const intent = String(form.get("_action") ?? "");
  try {
    switch (intent) {
      case "createTask": {
        const due = String(form.get("dueAt") ?? "").trim();
        await createTask(shop, {
          title: String(form.get("title") ?? ""),
          notes: String(form.get("notes") ?? "") || null,
          dueAt: due ? new Date(`${due}T12:00:00`) : null,
        });
        return { ok: true, toast: "Task created." };
      }
      case "toggleTask":
        await setTaskStatus(
          shop,
          String(form.get("taskId") ?? ""),
          form.get("status") === "DONE" ? "DONE" : "OPEN",
        );
        return { ok: true, toast: "Task updated." };
      case "deleteTask":
        await deleteTask(shop, String(form.get("taskId") ?? ""));
        return { ok: true, toast: "Task deleted." };
      default:
        return { ok: false, toast: "Unknown action." };
    }
  } catch (error) {
    return { ok: false, toast: error instanceof Error ? error.message : "Action failed." };
  }
};

type TaskView = {
  id: string;
  title: string;
  notes: string | null;
  status: string;
  dueAt: Date | string | null;
  contactId: string | null;
  contactName: string | null;
};

function TaskRow({ task }: { task: TaskView }) {
  return (
    <s-box padding="small-200" borderRadius="base" background="subdued">
      <s-stack direction="inline" gap="base" alignItems="center">
        <TaskStatusBadge status={task.status} />
        <s-stack direction="block" gap="small-500">
          <s-text type="strong">{task.title}</s-text>
          <s-stack direction="inline" gap="base">
            {task.dueAt && <s-text color="subdued">Due {formatDate(task.dueAt)}</s-text>}
            {task.contactId && task.contactName && (
              <s-link href={`/app/contacts/${task.contactId}`}>{task.contactName}</s-link>
            )}
          </s-stack>
          {task.notes && <s-text color="subdued">{task.notes}</s-text>}
        </s-stack>
        <Form method="post">
          <input type="hidden" name="_action" value="toggleTask" />
          <input type="hidden" name="taskId" value={task.id} />
          <input
            type="hidden"
            name="status"
            value={task.status === "DONE" ? "OPEN" : "DONE"}
          />
          <s-button type="submit" variant="tertiary">
            {task.status === "DONE" ? "Reopen" : "Mark done"}
          </s-button>
        </Form>
        <ConfirmAction
          id={`confirm-del-task-${task.id}`}
          triggerIcon="delete"
          triggerAccessibilityLabel="Delete task"
          heading="Delete task?"
          message={`The task “${task.title}” will be removed.`}
          confirmLabel="Delete task"
          fields={{ _action: "deleteTask", taskId: task.id }}
        />
      </s-stack>
    </s-box>
  );
}

function TaskGroup({ heading, tasks, tone }: { heading: string; tasks: TaskView[]; tone?: "critical" }) {
  if (tasks.length === 0) return null;
  return (
    <s-section heading={`${heading} (${tasks.length})`}>
      <s-stack direction="block" gap="small-200">
        {tone === "critical" && (
          <s-badge tone="critical">Needs attention</s-badge>
        )}
        {tasks.map((t) => (
          <TaskRow key={t.id} task={t} />
        ))}
      </s-stack>
    </s-section>
  );
}

export default function TasksPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const shopify = useAppBridge();
  const lastToast = useRef<string | null>(null);
  useEffect(() => {
    if (actionData?.toast && actionData.toast !== lastToast.current) {
      lastToast.current = actionData.toast;
      shopify.toast.show(actionData.toast, actionData.ok ? {} : { isError: true });
    }
  }, [actionData, shopify]);

  const empty =
    data.openCount === 0 && data.done.length === 0;

  return (
    <s-page heading="Tasks">
      <s-section heading="New task">
        <Form method="post">
          <input type="hidden" name="_action" value="createTask" />
          <s-stack direction="block" gap="base">
            <s-stack direction="inline" gap="base" alignItems="end">
              <s-text-field name="title" label="Task" placeholder="Call back about order…" required />
              <s-date-field name="dueAt" label="Due date" />
            </s-stack>
            <s-text-field name="notes" label="Notes (optional)" />
            <s-button type="submit" variant="primary">
              Add task
            </s-button>
          </s-stack>
        </Form>
      </s-section>

      {empty && (
        <s-section heading="No tasks yet">
          <s-paragraph color="subdued">
            Create a task above, or add one from a contact&apos;s page to keep follow-ups on
            track.
          </s-paragraph>
        </s-section>
      )}

      <TaskGroup heading="Overdue" tasks={data.overdue} tone="critical" />
      <TaskGroup heading="Due today" tasks={data.today} />
      <TaskGroup heading="Upcoming" tasks={data.upcoming} />
      <TaskGroup heading="No due date" tasks={data.noDueDate} />
      <TaskGroup heading="Done" tasks={data.done} />
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
