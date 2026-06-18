// Códigos SEFAZ para o catálogo (selects) + validação server-side. Constantes de
// STRING puras (NÃO enums do Prisma) → seguras no client e compartilhadas com a action.
//
// ⚠️ Rótulos simplificados; a escolha de CSOSN por cenário precisa de validação
// contábil (CLAUDE.md: FLAG, não assuma).

export const CSOSN_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "101", label: "101 — Tributada com permissão de crédito" },
  { value: "102", label: "102 — Tributada sem permissão de crédito" },
  { value: "103", label: "103 — Isenção do ICMS (faixa de receita bruta)" },
  { value: "201", label: "201 — Tributada c/ permissão de crédito e ST" },
  { value: "202", label: "202 — Tributada s/ permissão de crédito e ST" },
  { value: "203", label: "203 — Isenção do ICMS (faixa de receita) e ST" },
  { value: "300", label: "300 — Imune" },
  { value: "400", label: "400 — Não tributada" },
  { value: "500", label: "500 — ICMS cobrado anteriormente por ST" },
  { value: "900", label: "900 — Outros" },
];

export const ORIGEM_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "0", label: "0 — Nacional" },
  { value: "1", label: "1 — Estrangeira (importação direta)" },
  { value: "2", label: "2 — Estrangeira (adquirida no mercado interno)" },
  { value: "3", label: "3 — Nacional, conteúdo importado 40–70%" },
  { value: "4", label: "4 — Nacional (processos produtivos básicos)" },
  { value: "5", label: "5 — Nacional, conteúdo importado ≤ 40%" },
  { value: "6", label: "6 — Estrangeira (import. direta, sem similar nacional)" },
  { value: "7", label: "7 — Estrangeira (merc. interno, sem similar nacional)" },
  { value: "8", label: "8 — Nacional, conteúdo importado > 70%" },
];

export const CSOSN_VALUES: ReadonlySet<string> = new Set(
  CSOSN_OPTIONS.map((o) => o.value),
);
export const ORIGEM_VALUES: ReadonlySet<string> = new Set(
  ORIGEM_OPTIONS.map((o) => o.value),
);
