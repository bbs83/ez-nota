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

/**
 * Tempo (min) após o qual uma nota ainda em PROCESSING é considerada atrasada/presa.
 * PROVISÓRIO: a SEFAZ normalmente autoriza em segundos/minutos; 30 min é folga
 * (fila/contingência). Ajustar quando houver métrica real do Focus.
 */
export const PROCESSING_STUCK_MINUTES = 30;

/** Data de corte: notas em PROCESSING criadas antes disso estão "atrasadas". */
function stuckCutoff(now: Date): Date {
  return new Date(now.getTime() - PROCESSING_STUCK_MINUTES * 60_000);
}

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
      cancelRequestedAt: true,
    },
  });

  // Idempotência: só PROCESSING é resolvível. Nunca re-resolve um terminal nem
  // rebaixa AUTHORIZED (decisão #4).
  if (!invoice || invoice.status !== InvoiceStatus.PROCESSING) return "noop";

  const now = new Date();

  // PROCESSING sem ref do engine não é consultável → ERROR (reemissível). Update
  // condicional para não rebaixar uma resolução concorrente. Conta como tentativa.
  if (!invoice.fiscalEngineRef) {
    const updated = await prisma.invoice.updateMany({
      where: { id: invoice.id, status: InvoiceStatus.PROCESSING },
      data: {
        status: InvoiceStatus.ERROR,
        mensagemSefaz: "Nota em processamento sem referência do provedor fiscal.",
        resolveAttempts: { increment: 1 },
        lastResolveAt: now,
      },
    });
    return updated.count > 0 ? "error" : "noop";
  }

  // Stamp da tentativa ANTES da consulta: registra resolveAttempts + lastResolveAt
  // mesmo que o engine exploda (a Invoice segue PROCESSING, mas a tentativa fica
  // marcada p/ a detecção de "presa"). Condicional a PROCESSING; os updates terminais
  // abaixo NÃO re-incrementam (evita dupla contagem).
  await prisma.invoice.updateMany({
    where: { id: invoice.id, status: InvoiceStatus.PROCESSING },
    data: { resolveAttempts: { increment: 1 }, lastResolveAt: now },
  });

  // Consulta SEMPRE via adapter (fronteira L3) — nunca o Focus direto.
  const result = await getFiscalEngine().getInvoiceStatus(invoice.fiscalEngineRef);

  switch (result.status) {
    case "PROCESSING":
      // Ainda na fila da SEFAZ: nada a gravar, segue PROCESSING.
      return "still_processing";

    case "AUTHORIZED": {
      const authorizedAt = new Date();
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
          authorizedAt,
          responsePayload: jsonOrNull(result.rawResponse),
        },
      });
      if (updated.count === 0) return "noop";

      // Encadeamento cancel-on-refund: se o pedido foi cancelado/reembolsado enquanto a
      // nota estava PROCESSING, a intenção ficou em cancelRequestedAt → cancela agora.
      // Best-effort: a autorização já está persistida, uma falha aqui não a desfaz.
      if (invoice.cancelRequestedAt) {
        try {
          await cancelAuthorizedInvoice({
            id: invoice.id,
            fiscalEngineRef: invoice.fiscalEngineRef,
            authorizedAt,
          });
        } catch {
          console.error(
            `[resolve] cancelamento encadeado falhou para invoice ${invoice.id}`,
          );
        }
      }
      return "authorized";
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
  /** Notas ainda em PROCESSING e acima do cutoff APÓS a varredura (presas/atrasadas). */
  stuck: number;
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
  const now = new Date();
  const pending = await prisma.invoice.findMany({
    where: { shopId, status: InvoiceStatus.PROCESSING },
    orderBy: { createdAt: "asc" }, // mais antigas (mais prováveis de estarem presas) primeiro
    take: limite,
    select: { id: true },
  });

  const summary: ReconcileSummary = {
    resolvidas: 0,
    aindaProcessando: 0,
    rejeitadas: 0,
    erros: 0,
    stuck: 0,
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

  // "Presas": ainda PROCESSING e acima do cutoff DEPOIS da varredura. Releitura do
  // estado pós-resolução (não dá para inferir do loop: notas além do `limite` também
  // contam, e o cutoff é por idade, não por desfecho desta passada).
  summary.stuck = await prisma.invoice.count({
    where: {
      shopId,
      status: InvoiceStatus.PROCESSING,
      createdAt: { lt: stuckCutoff(now) },
    },
  });

  return summary;
}

/** Visão agregada das notas em processamento de um shop (para a home). */
export interface ProcessingOverview {
  processando: number;
  atrasadas: number;
  cutoffMinutes: number;
}

/**
 * Conta as notas em PROCESSING e, dentro delas, as "atrasadas" (acima do cutoff).
 * Centraliza o uso do enum Prisma no servidor (a rota não importa valores do
 * @prisma/client — regra "Prisma no client").
 */
export async function getProcessingOverview(
  shopId: string,
): Promise<ProcessingOverview> {
  const now = new Date();
  const [processando, atrasadas] = await Promise.all([
    prisma.invoice.count({ where: { shopId, status: InvoiceStatus.PROCESSING } }),
    prisma.invoice.count({
      where: {
        shopId,
        status: InvoiceStatus.PROCESSING,
        createdAt: { lt: stuckCutoff(now) },
      },
    }),
  ]);
  return { processando, atrasadas, cutoffMinutes: PROCESSING_STUCK_MINUTES };
}

// ===========================================================================
// Cancel-on-refund — cancela a NF-e quando o pedido é cancelado/reembolsado.
// Tudo via adapter (fronteira L3); idempotente (update condicional ao estado).
// ===========================================================================

/** Janela "segura" de cancelamento normal na SEFAZ (~24h após a autorização). */
const CANCEL_SAFE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Justificativa do cancelamento (a SEFAZ exige 15–255 chars). FLAG: texto e a janela
 * legal de cancelamento variam por UF — validar com contador.
 */
const CANCEL_JUSTIFICATIVA =
  "Cancelamento por reembolso/cancelamento do pedido no e-commerce";

export type CancelOutcome =
  | "cancelled" // AUTHORIZED → CANCELLED (homologado pela SEFAZ)
  | "refused" // SEFAZ recusou; a nota SEGUE AUTHORIZED
  | "cancel_error" // erro técnico no cancelamento; a nota SEGUE AUTHORIZED
  | "intent_recorded" // PROCESSING: intenção gravada (cancelRequestedAt)
  | "noop"; // sem nota / sem nota válida / já cancelada / concorrência

/**
 * Cancela uma Invoice AUTHORIZED via adapter. Update CONDICIONAL a status = AUTHORIZED
 * (anti-corrida): só uma chamada efetiva a transição. Recusa/erro mantêm AUTHORIZED e
 * gravam o motivo em mensagemSefaz. >24h desde a autorização: apenas sinaliza o risco
 * (loga) e tenta mesmo assim — a SEFAZ é a autoridade sobre o prazo.
 */
async function cancelAuthorizedInvoice(invoice: {
  id: string;
  fiscalEngineRef: string;
  authorizedAt: Date | null;
}): Promise<CancelOutcome> {
  const now = new Date();
  if (
    invoice.authorizedAt &&
    now.getTime() - invoice.authorizedAt.getTime() > CANCEL_SAFE_WINDOW_MS
  ) {
    // Risco: pode ser recusado e exigir nota de devolução. Não bloqueia.
    console.warn(
      `[cancel] invoice ${invoice.id}: >24h desde a autorização; cancelamento pode ser recusado`,
    );
  }

  // Consulta SEMPRE via adapter (fronteira L3) — nunca o Focus direto.
  const result = await getFiscalEngine().cancelInvoice({
    engineRef: invoice.fiscalEngineRef,
    justificativa: CANCEL_JUSTIFICATIVA,
  });

  if (result.status === "cancelado") {
    const updated = await prisma.invoice.updateMany({
      where: { id: invoice.id, status: InvoiceStatus.AUTHORIZED },
      data: {
        status: InvoiceStatus.CANCELLED,
        cancelledAt: now,
        protocoloCancelamento: result.protocoloCancelamento,
        mensagemSefaz: result.sefazMessage,
        responsePayload: jsonOrNull(result.rawResponse),
      },
    });
    return updated.count > 0 ? "cancelled" : "noop";
  }

  // Recusa/erro: a nota SEGUE AUTHORIZED. Grava o motivo (condicional a AUTHORIZED para
  // não sobrescrever uma transição concorrente).
  await prisma.invoice.updateMany({
    where: { id: invoice.id, status: InvoiceStatus.AUTHORIZED },
    data: {
      mensagemSefaz: result.sefazMessage,
      responsePayload: jsonOrNull(result.rawResponse),
    },
  });
  console.warn(
    `[cancel] invoice ${invoice.id}: SEFAZ ${result.status} (status ${result.sefazStatus ?? "?"})`,
  );
  return result.status === "recusado" ? "refused" : "cancel_error";
}

/**
 * Cancel-on-refund por pedido. Acha a Invoice por shopId:orderId (mesma chave do
 * idempotencyKey/engineRef) e aplica o tratamento por estado. Idempotente: sinais
 * repetidos (orders/cancelled E refunds/create do mesmo pedido) não cancelam 2x.
 */
export async function cancelInvoiceForOrder(
  shopId: string,
  orderId: string,
): Promise<CancelOutcome> {
  const idempotencyKey = `${shopId}:${orderId}`;
  const invoice = await prisma.invoice.findUnique({
    where: { idempotencyKey },
    select: { id: true, status: true, fiscalEngineRef: true, authorizedAt: true },
  });
  if (!invoice) {
    console.log(`[cancel] pedido ${orderId}: sem Invoice; nada a cancelar`);
    return "noop";
  }

  switch (invoice.status) {
    case InvoiceStatus.AUTHORIZED:
      if (!invoice.fiscalEngineRef) {
        console.error(
          `[cancel] invoice ${invoice.id} AUTHORIZED sem engineRef; não cancelável`,
        );
        return "noop";
      }
      return cancelAuthorizedInvoice({
        id: invoice.id,
        fiscalEngineRef: invoice.fiscalEngineRef,
        authorizedAt: invoice.authorizedAt,
      });

    case InvoiceStatus.PROCESSING: {
      // Ainda não autorizada → registra a INTENÇÃO (condicional + só se ainda não houver);
      // o resolver encadeia o cancelamento ao autorizar (PROCESSING→AUTHORIZED).
      const updated = await prisma.invoice.updateMany({
        where: {
          id: invoice.id,
          status: InvoiceStatus.PROCESSING,
          cancelRequestedAt: null,
        },
        data: { cancelRequestedAt: new Date() },
      });
      if (updated.count > 0) {
        console.log(
          `[cancel] pedido ${orderId}: nota em PROCESSING; intenção de cancelamento registrada`,
        );
      }
      return "intent_recorded";
    }

    case InvoiceStatus.REJECTED:
    case InvoiceStatus.ERROR:
      // Nunca houve nota válida no SEFAZ → nada a cancelar (no-op fiscal).
      console.log(
        `[cancel] pedido ${orderId}: nota ${invoice.status} (sem nota válida); no-op fiscal`,
      );
      return "noop";

    case InvoiceStatus.CANCELLED:
      return "noop"; // idempotente

    default: // PENDING ou estado inesperado
      console.log(`[cancel] pedido ${orderId}: status ${invoice.status}; no-op`);
      return "noop";
  }
}

/**
 * Reembolso PARCIAL: NÃO cancela a NF-e (documento do pedido inteiro). Apenas sinaliza
 * partialRefundAt para visibilidade/auditoria — devolução parcial é fluxo futuro (nota
 * de devolução). Idempotente (só marca se ainda não marcado).
 */
export async function markPartialRefundForOrder(
  shopId: string,
  orderId: string,
): Promise<boolean> {
  const idempotencyKey = `${shopId}:${orderId}`;
  const updated = await prisma.invoice.updateMany({
    where: { idempotencyKey, partialRefundAt: null },
    data: { partialRefundAt: new Date() },
  });
  return updated.count > 0;
}
