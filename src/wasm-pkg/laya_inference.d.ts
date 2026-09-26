/* tslint:disable */
/* eslint-disable */

/**
 * A loaded model instance (owned bytes + specialized runnables).
 * JS: `const m = LayaWasm.load(bytes); m.infer(ids, markers, q);`
 */
export class LayaWasm {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Number of cached specialized (S, M) runnables.
     */
    cache_size(): number;
    /**
     * Run one inference. `input_ids`: i64 array as BigInt64Array or
     * number[]; `marker_pos`: number[]; returns Float32Array logits.
     */
    infer(input_ids: BigInt64Array, marker_pos: BigInt64Array, qtype: bigint): Float32Array;
    /**
     * Parse + optimize ONNX bytes. Heavy (~seconds); call once.
     * `bytes`: full model.onnx contents.
     */
    static load(bytes: Uint8Array): LayaWasm;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_layawasm_free: (a: number, b: number) => void;
    readonly laya_infer: (a: number, b: number, c: number, d: number, e: number, f: bigint, g: number, h: number) => bigint;
    readonly laya_load: (a: number, b: number) => bigint;
    readonly layawasm_cache_size: (a: number) => number;
    readonly layawasm_infer: (a: number, b: number, c: number, d: number, e: number, f: bigint) => [number, number, number, number];
    readonly layawasm_load: (a: number, b: number) => [number, number, number];
    readonly __wbindgen_exn_store_command_export: (a: number) => void;
    readonly __externref_table_alloc_command_export: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc_command_export: (a: number, b: number) => number;
    readonly __externref_table_dealloc_command_export: (a: number) => void;
    readonly __wbindgen_free_command_export: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
