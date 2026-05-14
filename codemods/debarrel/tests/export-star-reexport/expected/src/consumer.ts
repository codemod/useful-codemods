import { AppError, isAppError } from "./lib/appError";
import { DEFAULT_CURRENCY } from "./lib/operations";

import type { AddressFragment, CurrencyFragment } from "./lib/operations";

export function describeAddress(addr: AddressFragment): string {
  return `${addr.line1 ?? ""} (${addr.city ?? ""})`;
}

export function defaultCurrency(): CurrencyFragment {
  return DEFAULT_CURRENCY;
}

export function wrapError(err: unknown): AppError {
  if (isAppError(err)) return err;
  return new AppError(String(err));
}
