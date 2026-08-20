/**
 * Versión del contrato que vincula spec, helpers, baseline y evidencias E2E.
 * Incrementarla obliga a reejecutar los CU que estaban verdes con una versión
 * anterior, en lugar de reutilizar resultados incompatibles.
 */
export const E2E_CONTRACT_VERSION = 10;

export interface E2EStatusLike {
  green?: unknown;
  at?: unknown;
  contractVersion?: unknown;
}

export function isCurrentGreenE2EStatus(entry: E2EStatusLike | undefined): boolean {
  return entry?.green === true && entry.contractVersion === E2E_CONTRACT_VERSION;
}
