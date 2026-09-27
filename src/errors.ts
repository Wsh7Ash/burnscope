/** Error hierarchy shared by burnscope. */

export class BurnscopeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Raised when metric input cannot be interpreted. */
export class ParseError extends BurnscopeError {
  readonly line: number | undefined;
  readonly text: string | undefined;

  constructor(message: string, line?: number, text?: string) {
    super(message);
    this.line = line;
    this.text = text;
  }
}

/** Raised when an SLO specification is invalid. */
export class SpecError extends BurnscopeError {}

/** Raised when a CLI invocation is invalid. */
export class UsageError extends BurnscopeError {}
