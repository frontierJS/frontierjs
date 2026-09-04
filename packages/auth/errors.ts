// errors.ts
// Named error types for the data layer.
//
// auth.ts used to throw plain `new Error('Invalid credentials')`. Junction's
// toFrameworkError() only honors its own FrameworkError subclasses, so every
// one of those reached the client as a **500 GeneralError** — a mistyped
// password was indistinguishable from a broken server, and Sierra's browser
// client (which keys off 401 to clear a stale token) never saw its signal.
//
// These types exist so the data layer can say precisely what went wrong
// WITHOUT importing HTTP semantics — auth.ts's header comment promises it
// "never touches HTTP — that is the plugin's job". plugin.ts owns the
// error → status mapping, in one place (see toHttpError there).
//
// They are exported from the package barrel so a consumer calling
// createLitestoneAuth() directly — with no Junction anywhere — can still
// `catch (e) { if (e instanceof InvalidCredentialsError) ... }`.

export class AuthError extends Error {
  /**
   * The HTTP status this error means.
   *
   * Declared here, on the domain error, so this package still imports NOTHING
   * from Junction — Junction's error boundary reads a numeric `status` off any
   * thrown error and maps it. That is the whole point: a package can produce
   * correct statuses without depending on the framework.
   *
   * Subclasses override it. The base stays 500 because an unclassified auth
   * failure really is a server error.
   */
  readonly status: number = 500

  constructor(message: string) {
    super(message)
    // `new.target` keeps the name correct for every subclass without each one
    // restating it — and the name is what shows up in logs.
    this.name = new.target.name
  }
}

/**
 * Wrong password, unknown email, or a missing password credential.
 *
 * Deliberately one type with one message for all three: telling the caller
 * *which* part was wrong is a user-enumeration oracle. → 401
 */
export class InvalidCredentialsError extends AuthError {
  constructor(message = 'Invalid credentials') { super(message) }
  readonly status = 401
}

/** createUser() against an email that already exists. → 409 */
export class EmailTakenError extends AuthError {
  constructor(message = 'Email already registered') { super(message) }
  readonly status = 409
}

/**
 * A password-reset or email-verification token that is unknown, already
 * consumed, or past its expiry. One type for all three — distinguishing them
 * tells an attacker whether a token ever existed. → 400
 */
export class InvalidTokenError extends AuthError {
  constructor(message = 'Invalid or expired token') { super(message) }
  readonly status = 400
}

/** The user a valid token or id points at no longer exists. → 404 */
export class UserNotFoundError extends AuthError {
  constructor(message = 'User not found') { super(message) }
  readonly status = 404
}

/**
 * The app is misconfigured — e.g. an API-key operation with no encryptionKey.
 * Inherits status 500 deliberately: this one is genuinely the server's fault.
 */
export class AuthConfigError extends AuthError {}

/**
 * Removing this credential would leave the account with no way in.
 *
 * 409 rather than 400: nothing about the request is malformed, the account is
 * in a state where this cannot be done — and it is recoverable by the caller,
 * which is what separates it from a refusal. Add another way in first.
 */
export class LastCredentialError extends AuthError {
  readonly name = 'LastCredentialError'
  readonly status = 409
}

/** Nothing here by that id — or nothing the caller may see, which reads the same. */
export class NotFoundError extends AuthError {
  readonly name = 'NotFoundError'
  readonly status = 404
}
