import type {
  CancelInvoiceInput,
  CancelInvoiceResult,
  EmitInvoiceInput,
  EmitInvoiceResult,
  FiscalEngineAdapter,
  InvoiceStatusResult,
  RegisterCompanyInput,
  RegisterCompanyResult,
} from "./types";

// Concrete adapter for Focus NFe (https://focusnfe.com.br). Every method is STUBBED
// for now (TODO + fake return) so the rest of the app can be built and exercised
// end-to-end before the HTTP integration lands. Auth will use FOCUS_API_TOKEN.
//
// IMPORTANT: callers must reach this only through getFiscalEngine() (see ./index),
// never import it from route handlers directly.
export class FocusNfeAdapter implements FiscalEngineAdapter {
  async registerCompany(
    emitente: RegisterCompanyInput,
    _certPfx: Buffer,
    _certPassword: string,
  ): Promise<RegisterCompanyResult> {
    // TODO(focus): POST /v2/empresas with the company data + base64(certPfx) + password.
    // The certificate and password are forwarded to Focus and held there; they are
    // never written to disk/DB by EZ Nota (CLAUDE.md decision #2).
    const token = process.env.FOCUS_API_TOKEN;
    if (!token) {
      // Not fatal while stubbed — real integration will require it.
      console.warn(
        "[FocusNfeAdapter] FOCUS_API_TOKEN is not set; using stubbed registerCompany.",
      );
    }
    const fakeRef = `focus_stub_${emitente.cnpj.replace(/\D/g, "")}`;
    return { companyRef: fakeRef };
  }

  async emitInvoice(input: EmitInvoiceInput): Promise<EmitInvoiceResult> {
    // TODO(focus): POST /v2/nfe?ref=... — build payload, forward, map response.
    return { engineRef: `focus_stub_nfe_${input.idempotencyKey}` };
  }

  async cancelInvoice(_input: CancelInvoiceInput): Promise<CancelInvoiceResult> {
    // TODO(focus): DELETE /v2/nfe/{ref} with justificativa.
    return { cancelled: true };
  }

  async getInvoiceStatus(_engineRef: string): Promise<InvoiceStatusResult> {
    // TODO(focus): GET /v2/nfe/{ref} and map "status" to InvoiceStatus.
    return { status: "PENDING" };
  }
}
