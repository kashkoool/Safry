export const supportedCurrencies = ["TRY", "SYP", "SAR", "USD", "EUR", "EGP"] as const;
export type SupportedCurrency = typeof supportedCurrencies[number];
