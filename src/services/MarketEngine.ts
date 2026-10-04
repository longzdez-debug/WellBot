export interface ParsedPrice {
  amount: number;
  currency: string;
}

export function parseMarketPrice(value: string | null | undefined): ParsedPrice | null {
  if (!value) return null;
  const text = value.replace(/\s+/g, '').trim().toUpperCase();
  const match = text.match(/^([0-9]+(?:[.,][0-9]+)?)(BYN|USD|EUR|RUB|UAH|PLN)$/);
  if (!match) return null;
  const amount = Number(match[1].replace(',', '.'));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return { amount, currency: match[2] };
}
