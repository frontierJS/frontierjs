/*
 * mailbox.d.ts — the kit's types, hand-written. Junction and the mail
 * connectors are TypeScript callers; same reason as `/mime`.
 */

/** `Name <address>`; the name bare where it is atoms, else a quoted-string; the address alone when there is no name. */
export function formatMailbox(address: string, name?: string | null): string
