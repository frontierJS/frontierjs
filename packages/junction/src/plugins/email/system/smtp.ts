// plugins/email/system/smtp.ts — COMPATIBILITY SHIM
//
// The SMTP client moved to src/mail/smtp.ts. Division of responsibility:
//
//   src/mail          — Junction's INTERNAL mail system: always available,
//                       used for notification / system email. Owns the
//                       SMTP client (the transport you can always rely on)
//                       and the IMail interface.
//   src/plugins/email — integrations with 3RD-PARTY email providers and
//                       the higher-level system/campaign email features.
//                       Builds ON TOP of src/mail's transport.
//
// This shim preserves the old import path.
export * from '../../../mail/smtp.ts'
