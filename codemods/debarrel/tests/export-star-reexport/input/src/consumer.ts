import {
  AppError,
  isAppError,
  DEFAULT_CURRENCY,
} from "./lib";

import type {
  AddressFragment,
  CurrencyFragment,
} from "./lib";

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
