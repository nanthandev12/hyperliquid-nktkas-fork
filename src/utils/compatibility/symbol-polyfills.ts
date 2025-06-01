/**
 * Polyfill for Symbol.asyncDispose and AsyncDisposable interface which are part of the ECMAScript proposal
 * "Explicit Resource Management" that may not be available in React Native environments
 */

// Add TypeScript declarations for Symbol.asyncDispose and AsyncDisposable
declare global {
  interface SymbolConstructor {
    readonly asyncDispose: unique symbol;
  }
  
  interface AsyncDisposable {
    [Symbol.asyncDispose](): Promise<void>;
  }
}

// Add the polyfill if it doesn't exist using nullish coalescing assignment
// This is the approach recommended in TypeScript 5.2 documentation
// @ts-ignore - Property may not exist on Symbol
Symbol.asyncDispose ??= Symbol('Symbol.asyncDispose');

export {};
