import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    staffProfile: { findUnique: vi.fn(), upsert: vi.fn() },
  },
}));
vi.mock("../../db.server", () => ({ default: prismaMock }));

import { getStaffProfile, setHomeLocation } from "./staff-profile.server";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("staff profile", () => {
  it("loads a profile by shop and staff id", async () => {
    prismaMock.staffProfile.findUnique.mockResolvedValue({ id: "profile-1" });

    await getStaffProfile("shop.example", "staff-1");

    expect(prismaMock.staffProfile.findUnique).toHaveBeenCalledWith({
      where: {
        shop_staffId: { shop: "shop.example", staffId: "staff-1" },
      },
    });
  });

  it("upserts the staff member's home location", async () => {
    prismaMock.staffProfile.upsert.mockResolvedValue({ id: "profile-1" });

    await setHomeLocation("shop.example", "staff-1", "location-9");

    expect(prismaMock.staffProfile.upsert).toHaveBeenCalledWith({
      where: {
        shop_staffId: { shop: "shop.example", staffId: "staff-1" },
      },
      update: { homeLocationId: "location-9" },
      create: {
        shop: "shop.example",
        staffId: "staff-1",
        homeLocationId: "location-9",
      },
    });
  });
});
