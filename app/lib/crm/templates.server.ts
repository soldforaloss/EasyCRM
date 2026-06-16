/** Message template CRUD (email/SMS, with merge variables in the body). SERVER ONLY. */

import prisma from "../../db.server";
import { isChannel, type Channel } from "./constants";

export async function listTemplates(shop: string, channel?: Channel) {
  return prisma.messageTemplate.findMany({
    where: { shop, ...(channel ? { channel } : {}) },
    orderBy: [{ channel: "asc" }, { name: "asc" }],
  });
}

export async function getTemplate(shop: string, id: string) {
  return prisma.messageTemplate.findFirst({ where: { shop, id } });
}

export interface TemplateInput {
  name: string;
  channel: string;
  subject?: string | null;
  body: string;
}

function validate(input: TemplateInput): { name: string; channel: Channel; subject: string | null; body: string } {
  const name = input.name.trim();
  if (!name) throw new Error("Template name is required.");
  if (!isChannel(input.channel)) throw new Error("Invalid channel.");
  const body = input.body.trim();
  if (!body) throw new Error("Template body is required.");
  const subject = input.channel === "EMAIL" ? input.subject?.trim() || null : null;
  return { name, channel: input.channel, subject, body };
}

export async function createTemplate(shop: string, input: TemplateInput) {
  const v = validate(input);
  return prisma.messageTemplate.create({
    data: { shop, name: v.name, channel: v.channel, subject: v.subject, body: v.body },
  });
}

export async function updateTemplate(shop: string, id: string, input: TemplateInput) {
  const v = validate(input);
  const result = await prisma.messageTemplate.updateMany({
    where: { shop, id },
    data: { name: v.name, channel: v.channel, subject: v.subject, body: v.body },
  });
  if (result.count === 0) throw new Error("Template not found.");
}

export async function deleteTemplate(shop: string, id: string): Promise<void> {
  await prisma.messageTemplate.deleteMany({ where: { shop, id } });
}
