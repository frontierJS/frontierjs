export declare function generateUlid(): string
export declare function generateCuid(): string
export declare function generateNanoid(size?: number, alphabet?: string): string

export declare const ID_GENERATORS: Record<string, () => string>
export declare const GENERATED_DEFAULTS: Record<string, () => string>

export declare function mintId(kind: string): string | null
