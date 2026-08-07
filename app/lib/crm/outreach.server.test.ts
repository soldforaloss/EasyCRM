import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    contact: { findFirst: vi.fn() },
    activity: { create: vi.fn() },
  },
}));
vi.mock("../../db.server", () => ({ default: prismaMock }));

import { logOutreach } from "./outreach.server";

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.contact.findFirst.mockResolvedValue({ id: "contact-1" });
  prismaMock.activity.create.mockResolvedValue({ id: "activity-1" });
});

describe("logOutreach", () => {
  it.each([
    "OUTREACH_CALL",
    "OUTREACH_IN_PERSON",
    "OUTREACH_TEXT",
  ])("writes a %s activity with the note and staff attribution", async (type) => {
    await logOutreach("shop.example", "contact-1", {
      type,
      note: "  Discussed the new collection.  ",
      staffId: "staff-7",
    });

    expect(prismaMock.activity.create).toHaveBeenCalledWith({
      data: {
        shop: "shop.example",
        contactId: "contact-1",
        type,
        payload: JSON.stringify({
          note: "Discussed the new collection.",
          staffId: "staff-7",
        }),
        occurredAt: expect.any(Date),
      },
    });
  });

  it("rejects an invalid activity type before writing", async () => {
    await expect(
      logOutreach("shop.example", "contact-1", {
        type: "NOTE",
        note: "not outreach",
        staffId: "staff-7",
      }),
    ).rejects.toThrow("Choose a valid outreach method.");

    expect(prismaMock.contact.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.activity.create).not.toHaveBeenCalled();
  });
});
