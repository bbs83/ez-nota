import { EmitenteStatus, InvoiceStatus, Prisma } from "@prisma/client";
import prisma from "../db.server";
import { getFiscalEngine } from "./fiscal";
import type { EmissionStatus, EmitInvoiceInput, EmitInvoiceResult } from "./fiscal";
import { buildEmissionInput } from "./fiscal/order-mapping";
import {
  fetchFiscalOrder,
  fiscalOrderFromWebhookPayload,
  type AdminGraphqlClient,
  type FiscalOrder,
  type ShopifyOrderPayload,
} from "./fiscal/shopify-order.server";
import { lookupCep } from "./lookup/viacep.server";
import type { CepLookupResult } from "./lookup/types";
import { isValidCep, onlyDigits } from "./validation/br-documents";

const TO_INVOICE_STATUS: Record<EmissionStatus, InvoiceStatus> = {
  AUTHORIZED: InvoiceStatus.AUTHORIZED,
  PROCESSING: InvoiceStatus.PROCESSING,
  REJECTED: InvoiceStatus.REJECTED,
  // Prisma InvoiceStatus não tem DENEGADO; persistimos como REJECTED (o
  // rejeicaoCodigo/mensagemSefaz preservam o motivo da denegação).
  DENEGADO: InvoiceStatus.REJECTED,
  CANCELLED: InvoiceStatus.CANCELLED,
  ERROR: InvoiceStatus.ERROR,
};

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

/** Marks an Invoice ERROR with a message. No emittedAt (nothing was emitted) — L4. */
function markInvoiceError(invoiceId: string, message: string) {
  return prisma.invoice.update({
    where: { id: invoiceId },
    data: { status: InvoiceStatus.ERROR, mensagemSefaz: message },
  });
}

/**
 * Emits an NF-e for a paid Shopify order. Everything is scoped by shopId.
 * Idempotent: a unique Invoice.idempotencyKey (shopId:orderId) means a duplicate
 * webhook never re-emits an authorized/processing note (CLAUDE.md decision #4),
 * while a previously failed (ERROR/REJECTED) note is reclaimed for a legit retry.
 *
 * Order data is enriched via Admin GraphQL (CPF via localizedFields, NCM via the
 * variant's HS code). LGPD/L8: never log CPF/address.
 *
 * Emission is ASYNCHRONOUS (mirrors real Focus): emitInvoice returns PROCESSING +
 * an engineRef, so the Invoice STOPS at PROCESSING here (status, fiscalEngineRef and
 * the reserved número are persisted). The terminal state (autorizado/rejeitado/
 * denegado) is resolved later by polling getInvoiceStatus(engineRef) — that resolver
 * + stuck-PROCESSING reclaim is M1 (next chunk; no auto-trigger yet).
 */
export async function handleOrderPaid(
  shopDomain: string,
  payload: ShopifyOrderPayload,
  admin?: AdminGraphqlClient,
): Promise<void> {
  const orderId = payload.id != null ? String(payload.id) : "";
  if (!orderId) {
    console.log("[orders/paid] payload sem id de pedido; ignorando");
    return;
  }

  const shop = await prisma.shop.findUnique({ where: { shopDomain } });
  if (!shop) {
    console.log(`[orders/paid] loja não encontrada (${shopDomain}); ignorando`);
    return;
  }

  const emitente = await prisma.emitente.findFirst({
    where: { shopId: shop.id, status: EmitenteStatus.ACTIVE },
    include: { fiscalSettings: true },
  });
  if (!emitente || !emitente.fiscalSettings) {
    console.log(
      `[orders/paid] sem Emitente ACTIVE/configurado para ${shopDomain}; ignorando`,
    );
    return;
  }
  const settings = emitente.fiscalSettings;
  const idempotencyKey = `${shop.id}:${orderId}`;

  // --- Claim atômico (nunca emitir NF-e duplicada) ---
  let invoiceId: string;
  try {
    const created = await prisma.invoice.create({
      data: {
        shopId: shop.id,
        emitenteId: emitente.id,
        shopifyOrderId: orderId,
        shopifyOrderName: payload.name ?? null,
        idempotencyKey,
        ambiente: settings.ambiente,
        tipo: settings.tipoDocumento,
        status: InvoiceStatus.PROCESSING,
      },
      select: { id: true },
    });
    invoiceId = created.id;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const existing = await prisma.invoice.findUnique({
      where: { idempotencyKey },
      select: { id: true, status: true },
    });
    if (!existing) throw error;
    if (
      existing.status === InvoiceStatus.AUTHORIZED ||
      existing.status === InvoiceStatus.PROCESSING ||
      existing.status === InvoiceStatus.CANCELLED
    ) {
      console.log(
        `[orders/paid] pedido ${orderId} já está ${existing.status}; ignorando`,
      );
      return;
    }
    const claimed = await prisma.invoice.updateMany({
      where: { id: existing.id, status: existing.status },
      data: {
        status: InvoiceStatus.PROCESSING,
        mensagemSefaz: null,
        rejeicaoCodigo: null,
      },
    });
    if (claimed.count === 0) {
      console.log(
        `[orders/paid] pedido ${orderId} reivindicado em paralelo; ignorando`,
      );
      return;
    }
    invoiceId = existing.id;
  }

  // --- Dados do pedido: GraphQL (primário) → fallback do payload do webhook ---
  let order: FiscalOrder;
  if (admin) {
    try {
      order = await fetchFiscalOrder(admin, `gid://shopify/Order/${orderId}`);
    } catch {
      // L5: com admin disponível, NÃO emitir com dados degradados — registra ERROR
      // (reemitível) e relança para o Shopify reenviar o webhook. Log sem PII.
      console.error(`[orders/paid] consulta do pedido ${orderId} no Shopify falhou`);
      await markInvoiceError(
        invoiceId,
        "Falha ao consultar o pedido no Shopify; será reprocessado.",
      );
      throw new Error(`order fetch failed (${orderId})`);
    }
  } else {
    order = fiscalOrderFromWebhookPayload(payload);
    console.log(
      `[orders/paid] ${orderId}: sessão admin indisponível; usando payload do webhook (degradado)`,
    );
  }

  // IBGE/bairro/município do destinatário via ViaCEP (best-effort).
  let destinatarioCep: CepLookupResult | null = null;
  const destCep = onlyDigits(order.enderecoEntrega?.zip ?? "");
  if (isValidCep(destCep)) {
    try {
      destinatarioCep = await lookupCep(destCep);
    } catch {
      /* best-effort; segue sem o IBGE */
    }
  }

  // --- Mapeamento + validação fiscal ---
  const variantIds = order.itens
    .map((i) => i.variantId)
    .filter((v): v is string => !!v);
  const mappings = variantIds.length
    ? await prisma.productFiscalMapping.findMany({
        where: { shopId: shop.id, shopifyVariantId: { in: variantIds } },
      })
    : [];
  const productMappings = new Map(mappings.map((m) => [m.shopifyVariantId, m]));

  const build = buildEmissionInput({
    emitente: { ...emitente, fiscalSettings: settings },
    order,
    productMappings,
    idempotencyKey,
    destinatarioCep,
  });

  // NCM ausente / exterior / >100 itens → ERROR permanente (sem emitir, sem numerar).
  if (!build.ok) {
    await markInvoiceError(invoiceId, build.error);
    console.log(`[orders/paid] pedido ${orderId} → ERROR (${build.error})`);
    return;
  }

  // --- M2: reserva o número ATOMICAMENTE antes de emitir ---
  // Incremento atômico evita número duplicado sob concorrência (decisão #4).
  // Aceita gaps: uma rejeição/erro "queima" o número (resolvível por inutilização).
  const reserved = await prisma.fiscalSettings.update({
    where: { id: settings.id },
    data: { proximoNumero: { increment: 1 } },
    select: { proximoNumero: true },
  });
  const numero = reserved.proximoNumero - 1;
  const input: EmitInvoiceInput = { ...build.input, numero };

  // --- Emissão via adapter (stub): assíncrona → resultado PROCESSING + engineRef ---
  let result: EmitInvoiceResult;
  try {
    result = await getFiscalEngine().emitInvoice(input);
  } catch {
    // Não logar payload/erro cru — pode conter dados sensíveis (L8 / decisão #5).
    console.error(`[orders/paid] emitInvoice falhou para o pedido ${orderId}`);
    result = {
      status: "ERROR",
      engineRef: null,
      chaveAcesso: null,
      numero: null,
      serie: null,
      protocolo: null,
      xmlUrl: null,
      danfeUrl: null,
      sefazStatus: null,
      sefazMessage: "Falha ao chamar o provedor fiscal.",
      rejectionCode: null,
      rawRequest: null,
      rawResponse: { error: "engine_call_failed" },
    };
  }

  const invoiceStatus = TO_INVOICE_STATUS[result.status];
  const usedNumero = result.numero ?? numero;
  const usedSerie = result.serie ?? settings.serie;
  const now = new Date();

  await prisma.invoice.update({
    where: { id: invoiceId },
    data: {
      status: invoiceStatus,
      fiscalEngineRef: result.engineRef,
      numero: usedNumero,
      serie: usedSerie,
      chaveAcesso: result.chaveAcesso,
      protocolo: result.protocolo,
      xmlUrl: result.xmlUrl,
      danfeUrl: result.danfeUrl,
      valorTotal: input.valorTotal,
      mensagemSefaz: result.sefazMessage,
      rejeicaoCodigo: result.rejectionCode,
      requestPayload:
        result.rawRequest == null
          ? Prisma.JsonNull
          : (result.rawRequest as Prisma.InputJsonValue),
      responsePayload:
        result.rawResponse == null
          ? Prisma.JsonNull
          : (result.rawResponse as Prisma.InputJsonValue),
      emittedAt: now,
      authorizedAt: invoiceStatus === InvoiceStatus.AUTHORIZED ? now : null,
    },
  });

  console.log(
    `[orders/paid] pedido ${orderId} → ${invoiceStatus} (nº ${usedNumero}/${usedSerie})`,
  );
}
