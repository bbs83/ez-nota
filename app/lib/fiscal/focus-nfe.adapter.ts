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
import { buildFocusNfePayload, type FocusNfePayload } from "./nfe-payload";

// Concrete adapter for Focus NFe (https://focusnfe.com.br). Network calls are still
// STUBBED, but the parsing path is real: emitInvoice builds the real Focus payload,
// produces a Focus-shaped "autorizado" response, and runs it through the same
// parser the live integration will use (high fidelity). Auth will use FOCUS_API_TOKEN.
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
    case "erro_autorizacao":
    case "denegado": // SEFAZ denied; nosso enum não tem DENEGADO → REJECTED
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
function fakeChave(payload: FocusNfePayload): string {
  const seed = `3524${payload.cnpj_emitente}55${payload.items.length}`;
  return (seed + "0".repeat(44)).slice(0, 44);
}

export class FocusNfeAdapter implements FiscalEngineAdapter {
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
    // empresa. A resposta real pode vir "processando_autorizacao" → o polling
    // (processando → autorizado/rejeitado) é o próximo chunk. Não logar `payload`.
    const token = process.env.FOCUS_API_TOKEN;
    if (!token) {
      console.warn("[FocusNfeAdapter] FOCUS_API_TOKEN ausente; emitInvoice em modo stub.");
    }

    // STUB de alta fidelidade: resposta no formato real do Focus para "autorizado".
    const stubResponse: FocusNfeResponse = {
      status: "autorizado",
      ref: input.idempotencyKey,
      cnpj_emitente: payload.cnpj_emitente,
      chave_nfe: fakeChave(payload),
      numero: String(input.numero),
      serie: String(input.serie),
      caminho_xml_nota_fiscal: `/arquivos/${input.idempotencyKey}/nfe.xml`,
      caminho_danfe: `/arquivos/${input.idempotencyKey}/danfe.pdf`,
      status_sefaz: "100",
      mensagem_sefaz: "Autorizado o uso da NF-e",
      protocolo: `135${payload.cnpj_emitente}${input.numero}`.slice(0, 15),
    };

    return parseFocusResponse(stubResponse, payload);
  }

  async cancelInvoice(input: CancelInvoiceInput): Promise<CancelInvoiceResult> {
    // TODO(focus): DELETE /v2/nfe/{ref} com { justificativa }.
    return {
      status: "CANCELLED",
      sefazMessage: "Cancelamento registrado (stub)",
      rawResponse: { status: "cancelado", ref: input.engineRef },
    };
  }

  async getInvoiceStatus(engineRef: string): Promise<InvoiceStatusResult> {
    // TODO(focus): GET /v2/nfe/{ref} e mapear `status` → EmissionStatus.
    return {
      status: "AUTHORIZED",
      chaveAcesso: null,
      xmlUrl: null,
      danfeUrl: null,
      sefazMessage: "Autorizado o uso da NF-e (stub)",
      rawResponse: { status: "autorizado", ref: engineRef },
    };
  }
}
