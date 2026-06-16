/** Task CRUD + grouping for the global Tasks view. SERVER ONLY. */

import type { Prisma, Task } from "@prisma/client";
import prisma from "../../db.server";
import { isTaskStatus, type TaskStatus } from "./constants";
import { logActivity } from "./activity.server";

export interface TaskInput {
  title: string;
  notes?: string | null;
  dueAt?: Date | null;
  contactId?: string | null;
  assigneeStaffId?: string | null;
}

export interface TaskFilter {
  status?: TaskStatus;
  contactId?: string;
  assigneeStaffId?: string;
}

export type TaskWithContact = Prisma.TaskGetPayload<{
  include: { contact: { select: { id: true; firstName: true; lastName: true; email: true } } };
}>;

export async function listTasks(
  shop: string,
  filter: TaskFilter = {},
): Promise<TaskWithContact[]> {
  return prisma.task.findMany({
    where: {
      shop,
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.contactId ? { contactId: filter.contactId } : {}),
      ...(filter.assigneeStaffId ? { assigneeStaffId: filter.assigneeStaffId } : {}),
    },
    // dueAt asc puts NULLs first on SQLite; the global view regroups by bucket anyway.
    orderBy: [{ status: "asc" }, { dueAt: "asc" }, { createdAt: "desc" }],
    include: {
      contact: { select: { id: true, firstName: true, lastName: true, email: true } },
    },
  });
}

export async function createTask(shop: string, input: TaskInput): Promise<Task> {
  const title = input.title.trim();
  if (!title) throw new Error("Task title is required.");

  // If tied to a contact, ensure it belongs to the shop.
  if (input.contactId) {
    const contact = await prisma.contact.findFirst({
      where: { id: input.contactId, shop },
      select: { id: true },
    });
    if (!contact) throw new Error("Contact not found.");
  }

  const task = await prisma.task.create({
    data: {
      shop,
      title,
      notes: input.notes?.trim() || null,
      dueAt: input.dueAt ?? null,
      contactId: input.contactId ?? null,
      assigneeStaffId: input.assigneeStaffId ?? null,
      status: "OPEN",
    },
  });

  if (task.contactId) {
    await logActivity({
      shop,
      contactId: task.contactId,
      type: "TASK",
      payload: { taskId: task.id, title: task.title, action: "created" },
    });
  }
  return task;
}

export async function updateTask(
  shop: string,
  taskId: string,
  input: Partial<TaskInput> & { status?: string },
): Promise<void> {
  const data: Prisma.TaskUpdateManyMutationInput = {};
  if (input.title !== undefined) {
    const t = input.title.trim();
    if (!t) throw new Error("Task title is required.");
    data.title = t;
  }
  if (input.notes !== undefined) data.notes = input.notes?.trim() || null;
  if (input.dueAt !== undefined) data.dueAt = input.dueAt;
  if (input.assigneeStaffId !== undefined)
    data.assigneeStaffId = input.assigneeStaffId ?? null;
  if (input.status !== undefined && isTaskStatus(input.status)) data.status = input.status;

  const result = await prisma.task.updateMany({ where: { shop, id: taskId }, data });
  if (result.count === 0) throw new Error("Task not found.");
}

export async function setTaskStatus(
  shop: string,
  taskId: string,
  status: TaskStatus,
): Promise<void> {
  await prisma.task.updateMany({ where: { shop, id: taskId }, data: { status } });
}

export async function deleteTask(shop: string, taskId: string): Promise<void> {
  await prisma.task.deleteMany({ where: { shop, id: taskId } });
}

export async function countOpenTasks(shop: string): Promise<number> {
  return prisma.task.count({ where: { shop, status: "OPEN" } });
}

export interface GroupedTasks {
  overdue: TaskWithContact[];
  today: TaskWithContact[];
  upcoming: TaskWithContact[];
  noDueDate: TaskWithContact[];
  done: TaskWithContact[];
}

/** Group tasks into due-buckets for the global Tasks view. */
export function groupTasks(tasks: TaskWithContact[], now = new Date()): GroupedTasks {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfToday = new Date(startOfToday.getTime() + 86_400_000);
  const groups: GroupedTasks = {
    overdue: [],
    today: [],
    upcoming: [],
    noDueDate: [],
    done: [],
  };
  for (const t of tasks) {
    if (t.status === "DONE") {
      groups.done.push(t);
      continue;
    }
    if (!t.dueAt) {
      groups.noDueDate.push(t);
    } else if (t.dueAt < startOfToday) {
      groups.overdue.push(t);
    } else if (t.dueAt < endOfToday) {
      groups.today.push(t);
    } else {
      groups.upcoming.push(t);
    }
  }
  return groups;
}
