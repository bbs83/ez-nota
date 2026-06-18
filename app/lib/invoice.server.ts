import { EmitenteStatus, InvoiceStatus, Prisma } from "@prisma/client";
import prisma from "../db.server";
import { getFiscalEngine } from "./fiscal";
import type { EmissionStatus, EmitInvoiceResult } from "./fiscal";
import {
  buildEmissionInput,
  type ShopifyOrderPayload,
} from "./fiscal/order-mapping";

const TO_INVOICE_STATUS: Record<EmissionStatus, InvoiceStatus> = {
  AUTHORIZED: InvoiceStatus.AUTHORIZED,
  PROCESSING: InvoiceStatus.PROCESSING,
  REJECTED: InvoiceStatus.REJECTED,
  CANCELLED: InvoiceStatus.CANCELLED,
  ERROR: InvoiceStatus.ERROR,
};

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

/**
 * Emits an NF-e for a paid Shopify order. Everything is scoped by shopId.
 * Idempotent: a unique Invoice.idempotencyKey (shopId:orderId) means a duplicate
 * webhook never re-emits an authorized/processing note (CLAUDE.md decision #4),
 * while a previously failed (ERROR/REJECTED) note is reclaimed for a legit retry.
 *
 * NOTE: emission runs synchronously here. With the real Focus integration this
 * should move to a queue (and poll processando→autorizado) — next chunk.
 */
export async function handleOrderPaid(
  shopDomain: string,
  order: ShopifyOrderPayload,
): Promise<void> {
  const orderId = order.id != null ? String(order.id) : "";
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
        shopifyOrderName: order.name ?? null,
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
    // Já autorizada / em processamento / cancelada → não reemite.
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
    // ERROR/REJECTED → retry legítimo: reivindica a linha atomicamente.
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

  // --- Numeração + montagem do payload ---
  const numero = settings.proximoNumero;
  const variantIds = (order.line_items ?? [])
    .map((li) => (li.variant_id != null ? String(li.variant_id) : ""))
    .filter(Boolean);
  const mappings = variantIds.length
    ? await prisma.productFiscalMapping.findMany({
        where: { shopId: shop.id, shopifyVariantId: { in: variantIds } },
      })
    : [];
  const productMappings = new Map(mappings.map((m) => [m.shopifyVariantId, m]));

  const input = buildEmissionInput({
    emitente: { ...emitente, fiscalSettings: settings },
    order,
    productMappings,
    numero,
  });

  // --- Emissão via adapter (stub) ---
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

  await prisma.$transaction(async (tx) => {
    await tx.invoice.update({
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

    // Avança a numeração só quando autorizou (um número rejeitado pode ser reusado).
    // FLAG: emissões concorrentes de pedidos diferentes podem pegar o mesmo
    // proximoNumero — alocação atômica de número fica para o mapeamento fino.
    if (invoiceStatus === InvoiceStatus.AUTHORIZED) {
      await tx.fiscalSettings.update({
        where: { id: settings.id },
        data: { proximoNumero: usedNumero + 1 },
      });
    }
  });

  console.log(
    `[orders/paid] pedido ${orderId} → ${invoiceStatus} (nº ${usedNumero}/${usedSerie})`,
  );
}
