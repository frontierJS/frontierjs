import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto"
import type { IDatabase } from "./db"

export interface CredentialInput {
  id:          string
  workspaceId: string
  name:        string
  provider:    string
  data:        Record<string, string>
}

export interface CredentialMeta {
  id:          string
  workspaceId: string
  name:        string
  provider:    string
  createdAt:   number
  updatedAt:   number
}

export interface ICredentialStore {
  save(cred: CredentialInput): void
  get(id: string): CredentialInput | undefined
  getByName(workspaceId: string, name: string): CredentialInput | undefined
  list(workspaceId: string): CredentialMeta[]
  delete(id: string): void
}

export class MissingSecretError extends Error {
  constructor() {
    super(
      "ORION_SECRET environment variable is required for credential encryption. " +
      "Set it to a long random string (min 32 chars) and restart.",
    )
    this.name = "MissingSecretError"
  }
}

const ALGORITHM  = "aes-256-gcm" as const
const IV_LENGTH  = 12
const KEY_LENGTH = 32

const keyCache = new Map<string, Buffer>()

function deriveKey(secret: string): Buffer {
  if (keyCache.has(secret)) return keyCache.get(secret)!
  const salt = Buffer.from("orion-credential-store-v1")
  const key  = scryptSync(secret, salt, KEY_LENGTH)
  keyCache.set(secret, key)
  return key
}

export class SQLiteCredentialStore implements ICredentialStore {
  private readonly key: Buffer

  constructor(private readonly db: IDatabase, secret?: string) {
    const s = secret ?? process.env["ORION_SECRET"]
    if (!s) throw new MissingSecretError()
    this.key = deriveKey(s)
  }

  save(cred: CredentialInput): void {
    const { ciphertext, iv, authTag } = encrypt(JSON.stringify(cred.data), this.key)
    const now = Date.now()
    this.db.run(
      `INSERT INTO credentials
         (id, workspaceId, name, provider, encryptedData, iv, authTag, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         name          = excluded.name,
         provider      = excluded.provider,
         encryptedData = excluded.encryptedData,
         iv            = excluded.iv,
         authTag       = excluded.authTag,
         updatedAt     = excluded.updatedAt`,
      [cred.id, cred.workspaceId, cred.name, cred.provider, ciphertext, iv, authTag, now, now],
    )
  }

  get(id: string): CredentialInput | undefined {
    const row = this.db.get<RawCred>("SELECT * FROM credentials WHERE id = ?", [id])
    return row ? this.rowToInput(row) : undefined
  }

  getByName(workspaceId: string, name: string): CredentialInput | undefined {
    const row = this.db.get<RawCred>(
      "SELECT * FROM credentials WHERE workspaceId = ? AND name = ?",
      [workspaceId, name],
    )
    return row ? this.rowToInput(row) : undefined
  }

  list(workspaceId: string): CredentialMeta[] {
    return this.db.all<RawCred>(
      "SELECT * FROM credentials WHERE workspaceId = ? ORDER BY name",
      [workspaceId],
    ).map(rowToMeta)
  }

  delete(id: string): void {
    this.db.run("DELETE FROM credentials WHERE id = ?", [id])
  }

  private rowToInput(row: RawCred): CredentialInput {
    const plaintext = decrypt(row.encryptedData, row.iv, row.authTag, this.key)
    let data: Record<string, string>
    try   { data = JSON.parse(plaintext) as Record<string, string> }
    catch { data = {} }
    return { id: row.id, workspaceId: row.workspaceId, name: row.name, provider: row.provider, data }
  }
}

interface Encrypted { ciphertext: string; iv: string; authTag: string }

function encrypt(plaintext: string, key: Buffer): Encrypted {
  const iv     = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const enc    = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  return {
    ciphertext: enc.toString("base64"),
    iv:         iv.toString("base64"),
    authTag:    cipher.getAuthTag().toString("base64"),
  }
}

function decrypt(ciphertext: string, ivB64: string, authTagB64: string, key: Buffer): string {
  const iv       = Buffer.from(ivB64, "base64")
  const authTag  = Buffer.from(authTagB64, "base64")
  const enc      = Buffer.from(ciphertext, "base64")
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(authTag)
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8")
}

interface RawCred {
  id:            string
  workspaceId:   string
  name:          string
  provider:      string
  encryptedData: string
  iv:            string
  authTag:       string
  createdAt:     number
  updatedAt:     number
}

function rowToMeta(row: RawCred): CredentialMeta {
  return {
    id:          row.id,
    workspaceId: row.workspaceId,
    name:        row.name,
    provider:    row.provider,
    createdAt:   row.createdAt,
    updatedAt:   row.updatedAt,
  }
}
