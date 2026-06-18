import { FocusNfeAdapter } from "./focus-nfe.adapter";
import type { FiscalEngineAdapter } from "./types";

// Single entry point for the fiscal engine. The rest of the app depends on the
// FiscalEngineAdapter interface returned here, so the concrete engine (Focus today,
// PlugNotas/NFE.io tomorrow) can be swapped in one place.
let instance: FiscalEngineAdapter | null = null;

export function getFiscalEngine(): FiscalEngineAdapter {
  if (!instance) {
    instance = new FocusNfeAdapter();
  }
  return instance;
}

export type {
  FiscalEngineAdapter,
  RegisterCompanyInput,
  RegisterCompanyResult,
  EmitInvoiceInput,
  EmitInvoiceResult,
  EmissionStatus,
  CancelInvoiceInput,
  CancelInvoiceResult,
  InvoiceStatusResult,
} from "./types";
