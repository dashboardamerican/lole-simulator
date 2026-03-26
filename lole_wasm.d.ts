/* tslint:disable */
/* eslint-disable */

/**
 * The main WASM engine — holds engine cache, config, and baseline state.
 */
export class WasmEngine {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Get default portfolio and peak forecast.
     */
    defaults(): string;
    /**
     * Evaluate a slice of scenarios — for multi-worker parallelism.
     */
    evaluate_slice(scenario_ids_json: string, config_json: string): string;
    /**
     * Health check.
     */
    health(): string;
    /**
     * Create a new WasmEngine from raw binary data and config JSON.
     *
     * Called by worker.js after fetching all .bin files.
     */
    constructor(manifest_json: string, config_json: string, load_scenarios: Uint8Array, forced_outage: Uint8Array, ambient_derate: Uint8Array, variable_profiles: Uint8Array, perf_day_idx_bytes: Uint8Array, all_day_ids_bytes: Uint8Array, pomo_weekly_bytes: Uint8Array);
    /**
     * Replay the worst single draw — returns per-class attribution windows.
     */
    replay_worst_draw(request_json: string): string;
    /**
     * Run a simulation — matches POST /simulate.
     */
    simulate(request_json: string): string;
    /**
     * Solve for required perfect capacity — matches POST /solve-target.
     */
    solve_target(request_json: string): string;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_wasmengine_free: (a: number, b: number) => void;
    readonly wasmengine_defaults: (a: number) => [number, number];
    readonly wasmengine_evaluate_slice: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly wasmengine_health: (a: number) => [number, number];
    readonly wasmengine_new: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number) => [number, number, number];
    readonly wasmengine_replay_worst_draw: (a: number, b: number, c: number) => [number, number];
    readonly wasmengine_simulate: (a: number, b: number, c: number) => [number, number];
    readonly wasmengine_solve_target: (a: number, b: number, c: number) => [number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
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
