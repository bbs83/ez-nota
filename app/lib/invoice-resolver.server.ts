import { InvoiceStatus, Prisma } from "@prisma/client";
import prisma from "../db.server";
import { getFiscalEngine } from "./fiscal";

// Transiciona Invoices de PROCESSING para o estado terminal consultando o engine
// via getInvoiceStatus(engineRef). TODA consulta passa pelo adapter (fronteira L3,
// decisão #1) — nunca chama o Focus direto. Idempotente: só age sobre PROCESSING e
// nunca rebaixa um estado terminal. É a base do futuro job agendado (M1) — por ora
// disparado manualmente pela tela. Sem gatilho automático (cron/callback) ainda.

/**
 * Desfecho de resolveInvoice para UMA Invoice. "noop" = nada a fazer (não estava
 * em PROCESSING, ou foi resolvida em paralelo); os demais espelham o estado terminal.
 */
export type ResolveOutcome =
  | "noop"
  | "still_processing"
  | "authorized"
  | "rejected"
  | "error"
  | "cancelled";

/** responsePayload: grava JSON ou JsonNull (mesmo padrão do invoice.server). */
function jsonOrNull(value: unknown) {
  return value == null ? Prisma.JsonNull : (value as Prisma.InputJsonValue);
}

/**
 * Resolve UMA Invoice em PROCESSING contra o engine. Idempotente e seguro sob
 * concorrência: o update final é condicionado a status = PROCESSING (updateMany),
 * então dois disparos simultâneos não colidem — o segundo vira no-op.
 *
 * Numeração: numa REJEIÇÃO/DENEGAÇÃO o número NÃO é mexido — já foi reservado/
 * consumido na emissão; o gap é aceitável (decisão #4). Inutilizar número rejeitado
 * é TODO (CLAUDE.md), não aqui.
 */
export async function resolveInvoice(invoiceId: string): Promise<ResolveOutcome> {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    select: {
      id: true,
      status: true,
      fiscalEngineRef: true,
      numero: true,
      serie: true,
    },
  });

  // Idempotência: só PROCESSING é resolvível. Nunca re-resolve um terminal nem
  // rebaixa AUTHORIZED (decisão #4).
  if (!invoice || invoice.status !== InvoiceStatus.PROCESSING) return "noop";

  // PROCESSING sem ref do engine não é consultável → ERROR (reemissível). Update
  // condicional para não rebaixar uma resolução concorrente.
  if (!invoice.fiscalEngineRef) {
    const updated = await prisma.invoice.updateMany({
      where: { id: invoice.id, status: InvoiceStatus.PROCESSING },
      data: {
        status: InvoiceStatus.ERROR,
        mensagemSefaz: "Nota em processamento sem referência do provedor fiscal.",
      },
    });
    return updated.count > 0 ? "error" : "noop";
  }

  // Consulta SEMPRE via adapter (fronteira L3) — nunca o Focus direto.
  const result = await getFiscalEngine().getInvoiceStatus(invoice.fiscalEngineRef);

  switch (result.status) {
    case "PROCESSING":
      // Ainda na fila da SEFAZ: nada a gravar, segue PROCESSING.
      return "still_processing";

    case "AUTHORIZED": {
      const updated = await prisma.invoice.updateMany({
        where: { id: invoice.id, status: InvoiceStatus.PROCESSING },
        data: {
          status: InvoiceStatus.AUTHORIZED,
          chaveAcesso: result.chaveAcesso,
          protocolo: result.protocolo,
          numero: result.numero ?? invoice.numero,
          serie: result.serie ?? invoice.serie,
          xmlUrl: result.xmlUrl,
          danfeUrl: result.danfeUrl,
          mensagemSefaz: result.sefazMessage,
          rejeicaoCodigo: null,
          authorizedAt: new Date(),
          responsePayload: jsonOrNull(result.rawResponse),
        },
      });
      return updated.count > 0 ? "authorized" : "noop";
    }

    // DENEGADO dobra em REJECTED (enum Prisma não tem DENEGADO; A1). O número
    // permanece (gap aceitável). Preserva motivo: mensagemSefaz + rejeicaoCodigo
    // (código de rejeição ou, na falta, o status SEFAZ).
    case "REJECTED":
    case "DENEGADO": {
      const updated = await prisma.invoice.updateMany({
        where: { id: invoice.id, status: InvoiceStatus.PROCESSING },
        data: {
          status: InvoiceStatus.REJECTED,
          mensagemSefaz: result.sefazMessage,
          rejeicaoCodigo: result.rejectionCode ?? result.sefazStatus,
          responsePayload: jsonOrNull(result.rawResponse),
        },
      });
      return updated.count > 0 ? "rejected" : "noop";
    }

    case "CANCELLED": {
      const updated = await prisma.invoice.updateMany({
        where: { id: invoice.id, status: InvoiceStatus.PROCESSING },
        data: {
          status: InvoiceStatus.CANCELLED,
          mensagemSefaz: result.sefazMessage,
          cancelledAt: new Date(),
          responsePayload: jsonOrNull(result.rawResponse),
        },
      });
      return updated.count > 0 ? "cancelled" : "noop";
    }

    case "ERROR":
    default: {
      const updated = await prisma.invoice.updateMany({
        where: { id: invoice.id, status: InvoiceStatus.PROCESSING },
        data: {
          status: InvoiceStatus.ERROR,
          mensagemSefaz: result.sefazMessage ?? "Erro ao consultar o status da nota.",
          responsePayload: jsonOrNull(result.rawResponse),
        },
      });
      return updated.count > 0 ? "error" : "noop";
    }
  }
}

/** Resumo de uma varredura de reconciliação. */
export interface ReconcileSummary {
  resolvidas: number;
  aindaProcessando: number;
  rejeitadas: number;
  erros: number;
}

/**
 * Varre as Invoices em PROCESSING do shop (mais antigas primeiro) e resolve cada
 * uma. Base do futuro job agendado. Sequencial e tolerante a falha por nota: se a
 * consulta de uma nota explodir, conta como erro de varredura e segue (a Invoice
 * fica em PROCESSING para a próxima passada). DENEGADO entra em "rejeitadas".
 */
export async function reconcilePendingInvoices(
  shopId: string,
  limite = 50,
): Promise<ReconcileSummary> {
  const pending = await prisma.invoice.findMany({
    where: { shopId, status: InvoiceStatus.PROCESSING },
    orderBy: { createdAt: "asc" },
    take: limite,
    select: { id: true },
  });

  const summary: ReconcileSummary = {
    resolvidas: 0,
    aindaProcessando: 0,
    rejeitadas: 0,
    erros: 0,
  };

  for (const { id } of pending) {
    let outcome: ResolveOutcome;
    try {
      outcome = await resolveInvoice(id);
    } catch {
      // Falha transitória ao consultar o engine: NÃO altera o estado da Invoice
      // (segue PROCESSING). Não logar erro cru — pode ter dado sensível (L8).
      console.error(`[reconcile] falha ao resolver invoice ${id}`);
      summary.erros += 1;
      continue;
    }
    switch (outcome) {
      case "authorized":
      case "cancelled":
        summary.resolvidas += 1;
        break;
      case "rejected":
        summary.rejeitadas += 1;
        break;
      case "error":
        summary.erros += 1;
        break;
      case "still_processing":
        summary.aindaProcessando += 1;
        break;
      case "noop":
        // Resolvida em paralelo ou sem ação — não conta.
        break;
    }
  }

  return summary;
}
