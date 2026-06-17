import { EmitenteStatus } from "@prisma/client";
import prisma from "../db.server";

// Tenant helpers. Every installed shop is a tenant (CLAUDE.md decision #3); all
// domain data is scoped by shopId. session.shop is the myshopify domain.

/**
 * Returns the Shop for this domain, creating it on first access. Reads first so
 * we don't issue a write on every request (L1); falls back to a re-read if a
 * concurrent request wins the create race (shopDomain is unique).
 */
export async function getOrCreateShop(shopDomain: string) {
  const existing = await prisma.shop.findUnique({ where: { shopDomain } });
  if (existing) return existing;
  try {
    return await prisma.shop.create({ data: { shopDomain } });
  } catch (error) {
    const created = await prisma.shop.findUnique({ where: { shopDomain } });
    if (created) return created;
    throw error;
  }
}

/** The active Emitente for a shop, if onboarding has completed. */
export function getActiveEmitente(shopId: string) {
  return prisma.emitente.findFirst({
    where: { shopId, status: EmitenteStatus.ACTIVE },
  });
}
