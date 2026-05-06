// ============================================================
// Junction Email — Types
// ============================================================

import type { SmtpConfig } from './system/smtp.ts'

// ─── Message ─────────────────────────────────────────────────

export interface EmailMessage {
  to:       string | string[]
  from?:    string              // overrides plugin-level default when provided
  subject:  string
  html?:    string
  text?:    string
  replyTo?: string
}

export interface EmailResult {
  // Locally-generated ID — use for correlation in logs.
  id:     string
  // 'sent'   — SMTP 250 received (system tier) or synchronous delivery confirmed
  // 'queued' — provider accepted for delivery (202 Accepted from Resend/Postmark etc.)
  status: 'sent' | 'queued'
}

// ─── System (Tier 1) ─────────────────────────────────────────

export interface SystemEmailConfig {
  // Default From address applied to every outgoing system email.
  // Can be overridden per-message via EmailMessage.from.
  from: string
  smtp: SmtpConfig
}

export interface ISystemEmail {
  send(message: EmailMessage): Promise<EmailResult>
}

// ─── Campaign (Tier 2) ───────────────────────────────────────
// Wired via Conduit — not implemented in Tier 1.
// Defined here so the plugin type is complete and callers can
// reference app.email.campaign without a type error even before
// Tier 2 is configured (it will throw at runtime if unconfigured).

export interface CampaignEmailConfig {
  // ID of the Conduit target to route campaign sends through.
  // e.g. 'provider:resend' or 'provider:postmark'
  target: string
  // Default From address for campaign emails.
  from:   string
}

export interface ICampaignEmail {
  send(message: EmailMessage): Promise<EmailResult>
}

// ─── Plugin options ──────────────────────────────────────────

export interface EmailOptions {
  system:    SystemEmailConfig
  campaign?: CampaignEmailConfig   // Tier 2 — optional
}

// ─── App surface ─────────────────────────────────────────────

export interface IEmail {
  system:    ISystemEmail
  campaign:  ICampaignEmail   // throws if campaign not configured
}
