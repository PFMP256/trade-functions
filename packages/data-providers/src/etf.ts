import Decimal from 'decimal.js';
import { etfReportSchema, type EtfReport, type Provenance } from '../../shared/src';
import { ProviderError } from './http';

export type EtfInputUnit = 'USD' | 'USD_MILLIONS';
/** Parses an explicitly supplied cell, not HTML. Dashes/empty cells are unknown and NEVER zero. */
export function parseEtfCell(raw: string | null, unit: EtfInputUnit): string | null {
  if (unit !== 'USD' && unit !== 'USD_MILLIONS') throw new ProviderError('ETF_UNSUPPORTED_UNIT');
  if (raw === null || /^[\s\-–—]*$/.test(raw)) return null;
  const value = raw.trim();
  const negative = /^\(.*\)$/.test(value);
  const unsigned = negative ? value.slice(1, -1) : value;
  if (!/^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(unsigned) || (negative && unsigned.startsWith('-'))) {
    throw new ProviderError('ETF_UNKNOWN_CELL_SYMBOL');
  }
  const amount = new Decimal(unsigned.replace(/,/g, '')).mul(negative ? -1 : 1).mul(unit === 'USD_MILLIONS' ? 1_000_000 : 1);
  return amount.toFixed();
}

export interface EtfStructuredCells {
  sessionDate: string;
  expectedFunds: string[];
  cells: Record<string, string | null>;
  declaredTotal: string | null;
  unit: EtfInputUnit;
  declaredComplete: boolean;
  provenance: Provenance;
}

/** The expected-fund universe belongs to a dated, verified feed revision; it is not a permanent fund count. */
export function normalizeEtfCells(input: EtfStructuredCells): EtfReport {
  if (input.expectedFunds.length === 0 || new Set(input.expectedFunds).size !== input.expectedFunds.length ||
      input.expectedFunds.some(fund => !/^[A-Z0-9.\-]{1,20}$/.test(fund))) throw new ProviderError('ETF_INVALID_FUND_UNIVERSE');
  const expected = new Set(input.expectedFunds);
  if (Object.keys(input.cells).some(fund => !expected.has(fund))) throw new ProviderError('ETF_UNEXPECTED_FUND');
  const funds = input.expectedFunds.map(fund => ({
    fund, rawValue: input.cells[fund] ?? '', netFlowUsd: parseEtfCell(input.cells[fund] ?? null, input.unit),
  }));
  const totalUsd = parseEtfCell(input.declaredTotal, input.unit);
  const covered = funds.every(fund => fund.netFlowUsd !== null);
  const sum = funds.reduce((total, fund) => total.plus(fund.netFlowUsd ?? '0'), new Decimal(0));
  const sumsMatch = totalUsd !== null && covered && sum.eq(totalUsd);
  return etfReportSchema.parse({ sessionDate: input.sessionDate, expectedFunds: [...input.expectedFunds], funds,
    totalUsd, complete: input.declaredComplete && covered && sumsMatch, unit: 'USD',
    provenance: { ...input.provenance, conflicts: [...input.provenance.conflicts,
      ...(covered && totalUsd !== null && !sumsMatch ? ['ETF_SUM_MISMATCH'] : [])] },
  });
}
