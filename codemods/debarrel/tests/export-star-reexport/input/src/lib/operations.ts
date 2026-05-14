export type AddressFragment = {
  line1?: string;
  city?: string;
};

export type CurrencyFragment = {
  code: string;
  symbol: string;
};

export const DEFAULT_CURRENCY: CurrencyFragment = {
  code: "USD",
  symbol: "$",
};
