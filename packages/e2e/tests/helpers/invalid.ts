/**
 * A value the type system would refuse, for tests of runtime validation:
 * `invalid<Locator>({})`, `invalid<ScrollOptions>({ speed: 'fast' })`. The one
 * place a test lies to the compiler, so the lie is named where it happens.
 */
export function invalid<T>(value: object): T {
  return value as unknown as T;
}
