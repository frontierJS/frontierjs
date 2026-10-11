// file-storage-credentials.test.ts — a remote provider with no credentials.
//
// `FJS-2420`. `provider: 'r2'` built, and the first upload died in the signer with
// `undefined is not an object (evaluating "secret.length")`. The refusal belongs at
// onInit, by the name of the option that is missing.

import { describe, test, expect } from 'bun:test'
import { parse } from '../src/index.js'
import { FileStorage } from '../src/storage/file-storage.js'

const schema = parse('model Doc {\n  id Int @id\n  cv File?\n}').schema
const init = (config: Record<string, unknown>) => {
  const ctx = { models: Object.fromEntries(schema.models.map((m: any) => [m.name, m])) }
  ;(FileStorage(config) as any).onInit(schema, ctx)
}

describe('FileStorage credentials are refused at onInit (FJS-2420)', () => {
  for (const provider of ['r2', 's3', 'b2', 'minio']) {
    test(`${provider} with no accessKeyId names it`, () => {
      expect(() => init({ provider, bucket: 'b', secretAccessKey: 's' })).toThrow(/accessKeyId/)
    })
    test(`${provider} with no secretAccessKey names it`, () => {
      expect(() => init({ provider, bucket: 'b', accessKeyId: 'a' })).toThrow(/secretAccessKey/)
    })
  }

  test('an endpoint alone (no provider) is S3-compatible and needs them too', () => {
    expect(() => init({ endpoint: 'https://x.test', bucket: 'b' })).toThrow(/accessKeyId/)
  })

  test('both stated builds; local needs neither', () => {
    expect(() => init({ provider: 'r2', bucket: 'b', accessKeyId: 'a', secretAccessKey: 's' })).not.toThrow()
    expect(() => init({ provider: 'local', bucket: 'b' })).not.toThrow()
  })
})
