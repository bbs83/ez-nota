// Validation/normalization for Brazilian fiscal documents. Pure functions, safe to
// use on both server and client (no Node/browser APIs).

/** Strips everything but digits. */
export function onlyDigits(value: string): string {
  return (value ?? "").replace(/\D/g, "");
}

export const normalizeCnpj = onlyDigits;
export const normalizeCep = onlyDigits;

/** Validates a CNPJ by length, repeated-digit guard, and the two check digits. */
export function isValidCnpj(value: string): boolean {
  const cnpj = onlyDigits(value);
  if (cnpj.length !== 14) return false;
  // Reject sequences like 00000000000000 that pass the checksum.
  if (/^(\d)\1{13}$/.test(cnpj)) return false;

  const checkDigit = (length: number): number => {
    let sum = 0;
    let pos = length - 7;
    for (let i = length; i >= 1; i--) {
      sum += parseInt(cnpj.charAt(length - i), 10) * pos;
      pos -= 1;
      if (pos < 2) pos = 9;
    }
    const result = sum % 11;
    return result < 2 ? 0 : 11 - result;
  };

  if (checkDigit(12) !== parseInt(cnpj.charAt(12), 10)) return false;
  if (checkDigit(13) !== parseInt(cnpj.charAt(13), 10)) return false;
  return true;
}

/** CEP is just 8 digits; ViaCEP confirms it actually exists. */
export function isValidCep(value: string): boolean {
  return onlyDigits(value).length === 8;
}

/** Progressive display mask for CNPJ: "12345678000199" -> "12.345.678/0001-99". */
export function maskCnpj(value: string): string {
  const d = onlyDigits(value).slice(0, 14);
  if (d.length <= 2) return d;
  if (d.length <= 5) return `${d.slice(0, 2)}.${d.slice(2)}`;
  if (d.length <= 8) return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5)}`;
  if (d.length <= 12)
    return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8)}`;
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(
    8,
    12,
  )}-${d.slice(12)}`;
}

/** Progressive display mask for CEP: "12345678" -> "12345-678". */
export function maskCep(value: string): string {
  const d = onlyDigits(value).slice(0, 8);
  if (d.length <= 5) return d;
  return `${d.slice(0, 5)}-${d.slice(5)}`;
}

/** Progressive display mask for BR phone: "(11) 91234-5678" or "(11) 1234-5678". */
export function maskPhone(value: string): string {
  const d = onlyDigits(value).slice(0, 11);
  if (d.length === 0) return "";
  if (d.length <= 2) return `(${d}`;
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}

/** Loose email format check (intentionally permissive). */
export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}
