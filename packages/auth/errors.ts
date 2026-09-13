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

/**
 * A password or a code offered to confirm an action, by a caller who is ALREADY
 * signed in, and it did not match — `changePassword`, and the second factor's
 * setup, confirm, disable and regenerate.
 *
 * 403 and not 401, because the session is fine. A 401 is what a client reads as
 * *this credential is not a session* and answers by signing the person out, so
 * a mistyped password on a settings screen cost the whole session — over HTTP,
 * and not over a socket, which is the same typo answered two ways (FJS-1088).
 * → 403
 */
export class ReauthenticationFailedError extends AuthError {
  constructor(message = 'Incorrect password') { super(message) }
  readonly status = 403
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

/**
 * A reset was redeemed against an account whose only way in is an OAuth
 * provider.
 *
 * Refused rather than turned into a create: that account was never secured by
 * its mailbox, and minting a password from an emailed token would make mailbox
 * access enough to take it over (FJS-987). An account with NO credential at all
 * is not refused — its mailbox is all that ever vouched for it (FJS-D265).
 *
 * Safe to be specific about — the caller reaching this presented a live reset
 * token, so they already hold the address, and `requestPasswordReset` stays
 * silent for exactly the caller who does not.
 */
export class NoPasswordCredentialError extends AuthError {
  readonly name = 'NoPasswordCredentialError'
  readonly status = 409
}

/** Nothing here by that id — or nothing the caller may see, which reads the same. */
export class NotFoundError extends AuthError {
  readonly name = 'NotFoundError'
  readonly status = 404
}

/**
 * A second factor is already on this account, so enrollment would overwrite the
 * secret the person's authenticator holds.
 *
 * Specific rather than folded into one message, because the caller is
 * authenticated and acting on their own account — there is nothing to enumerate,
 * and *you already have this* is the only answer a settings screen can act on.
 * → 409
 */
export class TotpAlreadyEnabledError extends AuthError {
  constructor(message = 'Two-factor authentication is already enabled') { super(message) }
  readonly status = 409
}

/**
 * A code that did not verify, a challenge that does not exist, one that has
 * lapsed, one that has been spent, and a code replayed inside its own window.
 *
 * One type and one message for all five, for the reason `InvalidCredentialsError`
 * is one for three: the differences are in the trail and nowhere the caller can
 * read. `retryable` is what a screen needs and it is FALSE once the challenge is
 * spent — a person typing into a box that will refuse every future code has been
 * told nothing.
 * → 401
 */
export class InvalidSecondFactorError extends AuthError {
  constructor(message = 'Invalid code', readonly retryable = true) { super(message) }
  readonly status = 401
}
