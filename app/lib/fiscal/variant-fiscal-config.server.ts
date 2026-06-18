import type { FiscalSettings, ProductFiscalMapping } from "@prisma/client";
import prisma from "../../db.server";

// Resolução compartilhada do config fiscal por variante (NCM, CFOP-base, CSOSN,
// origem) com a FONTE de cada valor. Mesma lógica usada pela emissão e (próximo
// passo) pelo catálogo fiscal — fonte única da verdade, sem duplicar nem divergir.
//
// IMPORTANTE: NÃO aplica o ajuste de CFOP por destino (intra/inter/exterior) — isso
// é específico da emissão (depende da UF do pedido) e continua em order-mapping.

export type FiscalSource = "shopify_hs" | "mapping" | "default" | "none";

export interface ResolvedFiscalField {
  /** Valor resolvido; "" quando source === "none". */
  value: string;
  source: FiscalSource;
}

export interface VariantFiscalConfig {
  /** NCM com 8 dígitos, ou "" (source "none") se nada resolver. */
  ncm: ResolvedFiscalField;
  /** CFOP BASE (sem ajuste de destino). */
  cfop: ResolvedFiscalField;
  csosn: ResolvedFiscalField;
  origem: ResolvedFiscalField;
}

/** Defaults relevantes do FiscalSettings. */
export type FiscalConfigDefaults = Pick<
  FiscalSettings,
  "defaultNcm" | "defaultCfop" | "defaultCsosn" | "defaultOrigem"
>;

/** Valores fiscais por variante (do ProductFiscalMapping). */
export type VariantMappingValues = Pick<
  ProductFiscalMapping,
  "ncm" | "cfop" | "csosn" | "origem"
>;

function onlyDigits(value: string | null | undefined): string {
  return (value ?? "").replace(/\D/g, "");
}

/** mapping (se preenchido) → default → none. Replica o `||` usado na emissão. */
function pickMappingOrDefault(
  mappingValue: string | null | undefined,
  defaultValue: string | null | undefined,
): ResolvedFiscalField {
  if (mappingValue) return { value: mappingValue, source: "mapping" };
  if (defaultValue) return { value: defaultValue, source: "default" };
  return { value: "", source: "none" };
}

/**
 * Núcleo puro da resolução. Determinístico, sem I/O.
 *
 * NCM (cascata): HS Brasil do variant (8 díg) → ProductFiscalMapping (8 díg) →
 * default (8 díg) → none.
 * CFOP-base / CSOSN / origem: ProductFiscalMapping (se preenchido) → default.
 */
export function resolveVariantFiscalConfig(args: {
  hsCodeBr: string | null;
  mapping: VariantMappingValues | null;
  defaults: FiscalConfigDefaults;
}): VariantFiscalConfig {
  const { hsCodeBr, mapping, defaults } = args;

  const hs = onlyDigits(hsCodeBr);
  const mapNcm = onlyDigits(mapping?.ncm);
  const defNcm = onlyDigits(defaults.defaultNcm);
  let ncm: ResolvedFiscalField;
  if (hs.length === 8) ncm = { value: hs, source: "shopify_hs" };
  else if (mapNcm.length === 8) ncm = { value: mapNcm, source: "mapping" };
  else if (defNcm.length === 8) ncm = { value: defNcm, source: "default" };
  else ncm = { value: "", source: "none" };

  return {
    ncm,
    cfop: pickMappingOrDefault(mapping?.cfop, defaults.defaultCfop),
    csosn: pickMappingOrDefault(mapping?.csosn, defaults.defaultCsosn),
    origem: pickMappingOrDefault(mapping?.origem, defaults.defaultOrigem),
  };
}

/**
 * Versão server que busca o ProductFiscalMapping (por shopId + variante) e resolve.
 * Pensada para o catálogo exibir o que cada variante resolve e de onde. A emissão
 * NÃO usa esta — ela busca os mappings em lote e chama o núcleo puro (evita N+1).
 */
export async function getVariantFiscalConfig(args: {
  shopId: string;
  shopifyVariantId: string | null;
  hsCodeBr: string | null;
  defaults: FiscalConfigDefaults;
}): Promise<VariantFiscalConfig> {
  const mapping = args.shopifyVariantId
    ? await prisma.productFiscalMapping.findUnique({
        where: {
          shopId_shopifyVariantId: {
            shopId: args.shopId,
            shopifyVariantId: args.shopifyVariantId,
          },
        },
        select: { ncm: true, cfop: true, csosn: true, origem: true },
      })
    : null;
  return resolveVariantFiscalConfig({
    hsCodeBr: args.hsCodeBr,
    mapping,
    defaults: args.defaults,
  });
}
