import type { IEmbeddingAdapter } from '@emma/core/ports';
export declare class VoyageEmbeddingAdapter implements IEmbeddingAdapter {
    private readonly apiKey;
    private readonly model;
    readonly dimensions = 1024;
    constructor(apiKey: string, model?: string);
    embed(text: string): Promise<number[]>;
    embedBatch(texts: string[]): Promise<number[][]>;
}
//# sourceMappingURL=VoyageAdapter.d.ts.map