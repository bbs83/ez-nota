import { onlyDigits } from "../validation/br-documents";
import type { CepLookupResult } from "./types";

/**
 * Looks up a CEP on ViaCEP. Returns null when the CEP is malformed or not found
 * (ViaCEP replies `{ erro: true }`); throws on network error.
 * Note ViaCEP's `ibge` field is what we store as codigoMunicipioIbge.
 */
export async function lookupCep(cep: string): Promise<CepLookupResult | null> {
  const digits = onlyDigits(cep);
  if (digits.length !== 8) return null;

  const res = await fetch(`https://viacep.com.br/ws/${digits}/json/`, {
    headers: { "User-Agent": "EZNota/1.0", Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`ViaCEP returned ${res.status}`);
  }

  const data = (await res.json()) as Record<string, unknown>;
  if (data.erro) return null;

  const str = (key: string): string => {
    const v = data[key];
    return v === null || v === undefined ? "" : String(v);
  };

  return {
    logradouro: str("logradouro"),
    bairro: str("bairro"),
    municipio: str("localidade"),
    uf: str("uf"),
    codigoMunicipioIbge: str("ibge"),
  };
}
