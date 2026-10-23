// Naru is English-only for now. Strata's Markdown component wraps strings in tr(); here it passes them through.
export function tr<T>(value: T, _values?: readonly unknown[]): T { return value; }
