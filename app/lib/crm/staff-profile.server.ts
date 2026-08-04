/** Per-staff CRM preferences. SERVER ONLY. */

import prisma from "../../db.server";

export async function getStaffProfile(shop: string, staffId: string) {
  return prisma.staffProfile.findUnique({
    where: { shop_staffId: { shop, staffId } },
  });
}

export async function setHomeLocation(
  shop: string,
  staffId: string,
  locationId: string | null,
) {
  return prisma.staffProfile.upsert({
    where: { shop_staffId: { shop, staffId } },
    update: { homeLocationId: locationId },
    create: { shop, staffId, homeLocationId: locationId },
  });
}
