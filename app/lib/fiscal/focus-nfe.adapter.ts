import type {
  CancelInvoiceInput,
  CancelInvoiceResult,
  EmitInvoiceInput,
  EmitInvoiceResult,
  EmissionStatus,
  FiscalEngineAdapter,
  InvoiceStatusResult,
  RegisterCompanyInput,
  RegisterCompanyResult,
} from "./types";
import { buildFocusNfePayload } from "./nfe-payload";

// Concrete adapter for Focus NFe (https://focusnfe.com.br). Network calls are still
// STUBBED, but the parsing path is real: emitInvoice builds the real Focus payload
// and runs Focus-shaped responses through the same parser the live integration will
// use (high fidelity). Auth will use FOCUS_API_TOKEN.
//
// ASYNCHRONOUS by design, mirroring real Focus: emitInvoice returns
// "processando_autorizacao" + a ref; the terminal state (autorizado/rejeitado/
// denegado) is observed later via getInvoiceStatus(ref). The stub fakes this with
// an in-memory poll counter — see getInvoiceStatus.
//
// IMPORTANT: callers reach this only through getFiscalEngine() (see ./index); the
// Focus wire format never escapes this file + nfe-payload.ts. NEVER log the request
// body or full errors (cert/password could leak) — CLAUDE.md decisions #2/#5 (L8).

/** Focus emission/consultation response (subset we use). */
interface FocusNfeResponse {
  status?: string;
  ref?: string;
  cnpj_emitente?: string;
  chave_nfe?: string;
  numero?: string;
  serie?: string;
  caminho_xml_nota_fiscal?: string;
  caminho_danfe?: string;
  status_sefaz?: string;
  mensagem_sefaz?: string;
  protocolo?: string;
  erros?: Array<{ codigo?: string; mensagem?: string }>;
}

/** Maps Focus's `status` to our engine-agnostic EmissionStatus. */
function mapFocusStatus(status: string): EmissionStatus {
  switch (status) {
    case "autorizado":
      return "AUTHORIZED";
    case "processando_autorizacao":
      return "PROCESSING";
    case "cancelado":
      return "CANCELLED";
    case "denegado":
      return "DENEGADO";
    case "erro_autorizacao":
      return "REJECTED";
    default:
      return "ERROR";
  }
}

function parseFocusResponse(
  resp: FocusNfeResponse,
  rawRequest: unknown,
): EmitInvoiceResult {
  const status = mapFocusStatus(resp.status ?? "");
  const firstErro = resp.erros?.[0] ?? null;
  const rejectionCode =
    status !== "AUTHORIZED"
      ? (firstErro?.codigo ?? resp.status_sefaz ?? null)
      : null;
  return {
    status,
    engineRef: resp.ref ?? null,
    chaveAcesso: resp.chave_nfe ?? null,
    numero: resp.numero != null ? Number(resp.numero) : null,
    serie: resp.serie != null ? Number(resp.serie) : null,
    protocolo: resp.protocolo ?? null,
    // FLAG: caminho_* é relativo; o link final precisa do host do Focus.
    xmlUrl: resp.caminho_xml_nota_fiscal ?? null,
    danfeUrl: resp.caminho_danfe ?? null,
    sefazStatus: resp.status_sefaz ?? null,
    sefazMessage: resp.mensagem_sefaz ?? firstErro?.mensagem ?? null,
    rejectionCode,
    rawRequest,
    rawResponse: resp,
  };
}

/** Deterministic fake 44-digit access key so the stub looks realistic. */
function fakeChave(cnpjEmitente: string, itemCount: number): string {
  const seed = `3524${cnpjEmitente}55${itemCount}`;
  return (seed + "0".repeat(44)).slice(0, 44);
}

/**
 * Projects a Focus consultation response into the engine-agnostic InvoiceStatusResult.
 * Reuses parseFocusResponse so the status mapping + field extraction live in one place.
 */
function toStatusResult(resp: FocusNfeResponse): InvoiceStatusResult {
  const r = parseFocusResponse(resp, null);
  return {
    status: r.status,
    chaveAcesso: r.chaveAcesso,
    numero: r.numero,
    serie: r.serie,
    protocolo: r.protocolo,
    xmlUrl: r.xmlUrl,
    danfeUrl: r.danfeUrl,
    sefazStatus: r.sefazStatus,
    sefazMessage: r.sefazMessage,
    rejectionCode: r.rejectionCode,
    rawResponse: r.rawResponse,
  };
}

// --- Stub async simulation (in-memory, per-process) -----------------------
// State kept ONLY by the stub so the asynchronous flow can be exercised end to end
// before the real Focus HTTP lands. Lost on restart (acceptable for dev/test).
interface StubDoc {
  polls: number;
  numero: number | null;
  serie: number | null;
  cnpjEmitente: string;
  itemCount: number;
}

/** Nº de consultas que respondem "processando" antes de virar terminal. */
const STUB_PROCESSING_POLLS = 1;

/**
 * Simulação DETERMINÍSTICA de desfecho (no espírito do bogus gateway do Shopify):
 * o desfecho depende dos ÚLTIMOS DÍGITOS do orderId (parte do ref após o último ":").
 *   - termina em "13"  → REJEITADO  (erro_autorizacao)
 *   - termina em "66"  → DENEGADO   (SEFAZ nega por irregularidade fiscal)
 *   - qualquer outro   → AUTORIZADO
 * Para forçar um desfecho num teste, basta o ref/idempotencyKey terminar no marcador
 * (ex.: "shop_x:99913" rejeita). Refs reais raramente colidem; em produção o stub é
 * substituído pelo HTTP real do Focus.
 */
function magicOutcome(ref: string): "rejeitado" | "denegado" | null {
  const orderId = ref.includes(":") ? ref.slice(ref.lastIndexOf(":") + 1) : ref;
  if (/13$/.test(orderId)) return "rejeitado";
  if (/66$/.test(orderId)) return "denegado";
  return null;
}

/**
 * Simulação DETERMINÍSTICA de RECUSA de cancelamento (mesmo espírito do magicOutcome):
 * o orderId (parte do ref após o último ":") terminando em "99" → SEFAZ RECUSA o
 * cancelamento (ex.: prazo expirado). Qualquer outro sufixo → cancelamento homologado.
 * Não colide com 13/66 (esses nem chegam a AUTHORIZED para serem cancelados).
 */
function magicCancelOutcome(ref: string): "recusado" | null {
  const orderId = ref.includes(":") ? ref.slice(ref.lastIndexOf(":") + 1) : ref;
  return /99$/.test(orderId) ? "recusado" : null;
}

export class FocusNfeAdapter implements FiscalEngineAdapter {
  /** Per-ref simulation state for the async stub (see getInvoiceStatus). */
  private readonly stubDocs = new Map<string, StubDoc>();

  async registerCompany(
    emitente: RegisterCompanyInput,
    _certPfx: Buffer,
    _certPassword: string,
  ): Promise<RegisterCompanyResult> {
    // TODO(focus): POST /v2/empresas with company data + base64(certPfx) + password.
    // Cert/password are forwarded to Focus and held there; never persisted by EZ Nota.
    const token = process.env.FOCUS_API_TOKEN;
    if (!token) {
      console.warn(
        "[FocusNfeAdapter] FOCUS_API_TOKEN ausente; registerCompany em modo stub.",
      );
    }
    return { companyRef: `focus_stub_${emitente.cnpj.replace(/\D/g, "")}` };
  }

  async emitInvoice(input: EmitInvoiceInput): Promise<EmitInvoiceResult> {
    const payload = buildFocusNfePayload(input);

    // TODO(focus): POST /v2/nfe?ref=<idempotencyKey> com `payload` e o token da
    // empresa. A resposta real costuma vir "processando_autorizacao"; o polling
    // (processando → autorizado/rejeitado) acontece em getInvoiceStatus. Não logar `payload`.
    const token = process.env.FOCUS_API_TOKEN;
    if (!token) {
      console.warn("[FocusNfeAdapter] FOCUS_API_TOKEN ausente; emitInvoice em modo stub.");
    }

    const ref = input.idempotencyKey;
    // Guarda o contexto da emissão para que getInvoiceStatus produza um "autorizado"
    // consistente (mesma chave/numero/serie) ao final do polling.
    this.stubDocs.set(ref, {
      polls: 0,
      numero: input.numero,
      serie: input.serie,
      cnpjEmitente: payload.cnpj_emitente,
      itemCount: payload.items.length,
    });

    // STUB assíncrono: resposta no formato real do Focus para "enfileirado". Sem
    // chave/numero/protocolo ainda — esses só existem após autorização na SEFAZ.
    const stubResponse: FocusNfeResponse = {
      status: "processando_autorizacao",
      ref,
      cnpj_emitente: payload.cnpj_emitente,
    };

    return parseFocusResponse(stubResponse, payload);
  }

  async cancelInvoice(input: CancelInvoiceInput): Promise<CancelInvoiceResult> {
    // TODO(focus): DELETE /v2/nfe/{ref} com { justificativa } → evento de cancelamento.
    // Não logar a justificativa nem o ref cru (podem correlacionar a pedido) — L8.
    const token = process.env.FOCUS_API_TOKEN;
    if (!token) {
      console.warn("[FocusNfeAdapter] FOCUS_API_TOKEN ausente; cancelInvoice em modo stub.");
    }

    // STUB: sucesso por padrão; RECUSA determinística por sufixo do ref (ver
    // magicCancelOutcome) para exercitar o ramo "SEFAZ recusou o cancelamento".
    if (magicCancelOutcome(input.engineRef) === "recusado") {
      return {
        status: "recusado",
        protocoloCancelamento: null,
        sefazStatus: "501",
        sefazMessage:
          "Rejeição: prazo para cancelamento superior ao permitido na legislação",
        rawResponse: {
          status: "erro_cancelamento",
          status_sefaz: "501",
          ref: input.engineRef,
        },
      };
    }

    return {
      status: "cancelado",
      protocoloCancelamento: `135${input.engineRef.replace(/\D/g, "")}`.slice(0, 15),
      sefazStatus: "135",
      sefazMessage: "Evento registrado e vinculado à NF-e (cancelamento homologado)",
      rawResponse: {
        status: "cancelado",
        status_sefaz: "135",
        ref: input.engineRef,
      },
    };
  }

  async getInvoiceStatus(engineRef: string): Promise<InvoiceStatusResult> {
    // TODO(focus): GET /v2/nfe/{ref}; mapear `status` → EmissionStatus via parseFocusResponse.

    // STUB assíncrono: as primeiras STUB_PROCESSING_POLLS consultas respondem
    // "processando"; depois o desfecho terminal. Desfecho determinístico por ref —
    // ver magicOutcome (rejeição/denegação por sufixo do orderId).
    const doc = this.stubDocs.get(engineRef) ?? {
      polls: 0,
      numero: null,
      serie: null,
      cnpjEmitente: "",
      itemCount: 1,
    };
    doc.polls += 1;
    this.stubDocs.set(engineRef, doc);

    if (doc.polls <= STUB_PROCESSING_POLLS) {
      return toStatusResult({ status: "processando_autorizacao", ref: engineRef });
    }

    switch (magicOutcome(engineRef)) {
      case "rejeitado":
        return toStatusResult({
          status: "erro_autorizacao",
          ref: engineRef,
          status_sefaz: "225",
          mensagem_sefaz: "Rejeição: Falha no schema XML da NF-e",
          erros: [{ codigo: "225", mensagem: "Rejeição: Falha no schema XML da NF-e" }],
        });
      case "denegado":
        return toStatusResult({
          status: "denegado",
          ref: engineRef,
          status_sefaz: "302",
          mensagem_sefaz: "Denegado: Irregularidade fiscal do destinatário",
        });
      default:
        return toStatusResult({
          status: "autorizado",
          ref: engineRef,
          cnpj_emitente: doc.cnpjEmitente,
          chave_nfe: fakeChave(doc.cnpjEmitente, doc.itemCount),
          numero: doc.numero != null ? String(doc.numero) : undefined,
          serie: doc.serie != null ? String(doc.serie) : undefined,
          caminho_xml_nota_fiscal: `/arquivos/${engineRef}/nfe.xml`,
          caminho_danfe: `/arquivos/${engineRef}/danfe.pdf`,
          status_sefaz: "100",
          mensagem_sefaz: "Autorizado o uso da NF-e",
          protocolo: `135${doc.cnpjEmitente}${doc.numero ?? ""}`.slice(0, 15),
        });
    }
  }
}
