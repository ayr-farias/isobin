/**
 * Compiler-emitted module-graph delta — topology (static + dynamic edges).
 * `ids[0, localCount)` are the modules this payload carries; `ids[localCount, …)` are foreign edge targets.
 * `edges[i]` / `dynamicEdges[i]` are the static / dynamic-`import()` out-edges of `ids[i]`.
 * `bindings[i][j]` are the export names `ids[i]` imports through `edges[i][j]`. `bindings` holds
 * only some rows; a missing row, or a missing or `null` entry, means the whole namespace.
 * `dynamicEdges` also holds only some rows; a missing row means no dynamic edges.
 * `stamps[i]` is the rebuild stamp of `ids[i]`; a missing row means 0.
 * `entries` lists the rows whose module is an entry.
 * @typedef {{ ids: string[], localCount: number, edges: number[][], bindings?: Record<number, (string[] | null)[]>, dynamicEdges?: Record<number, number[]>, stamps?: Record<number, number>, entries?: number[] }} ModuleGraphDelta
 * @typedef {{ createModuleHotContext(moduleId: string): any, onModuleCacheRemoval(moduleId: string): void }} DevRuntimeHooks
 */
export class MissingFactoryError {
    /**
     * @param {string} id
     */
    constructor(id: string);
    id: string;
}
export class DevRuntime {
    /**
     * @param {string} clientId
     */
    constructor(clientId: string);
    /**
     * Client ID generated at runtime initialization, used for lazy compilation requests.
     * @type {string}
     */
    clientId: string;
    /**
     * Static import edges from `registerGraph` — entries persist across `removeModuleCache`
     * and change only by replacement from a newer payload (last write wins).
     * `bindings` is the payload row as sent; `getImportedBindings` resolves a missing entry.
     * @type {Map<string, { edges: string[], bindings: (string[] | null)[] | undefined }>}
     */
    staticImports: Map<string, {
        edges: string[];
        bindings: (string[] | null)[] | undefined;
    }>;
    /**
     * Reverse index over the static imports.
     * @type {Map<string, Set<string>>}
     */
    importers: Map<string, Set<string>>;
    /**
     * Dynamic `import()` edges from `registerGraph`, keyed by importer — mirror of
     * `staticImports` for the dynamic reverse index.
     * @type {Map<string, { edges: string[] }>}
     */
    dynamicImports: Map<string, {
        edges: string[];
    }>;
    /**
     * Reverse index over the dynamic imports.
     * @type {Map<string, Set<string>>}
     */
    dynamicImporters: Map<string, Set<string>>;
    /** @type {Set<string>} */
    entries: Set<string>;
    /**
     * The module cache. Membership means "this module's side effects ran in this tab" —
     * registration is emitted ahead of every module body, and nothing un-registers on
     * unwind, so a factory that throws mid-body stays registered. A `Map` rather than a
     * plain object: HMR eviction deletes entries, and a `delete` on an object drops V8
     * into dictionary mode, taxing every later lookup on the hottest read path.
     * @type {Map<string, Module>}
     */
    moduleCache: Map<string, Module>;
    /**
     * Re-runnable factories from HMR patches and lazy chunks. The initial bundle stays
     * scope-hoisted and contributes none.
     * @type {Map<string, (id: string) => void>}
     */
    factories: Map<string, (id: string) => void>;
    /**
     * A late payload (a slow lazy chunk after an HMR patch) must not replace newer rows or
     * factories.
     * @type {Map<string, number>}
     */
    rowStamps: Map<string, number>;
    /** @type {Map<string, number>} */
    factoryStamps: Map<string, number>;
    /**
     * Installed by the dev client at boot. The runtime is a store + executor and makes
     * no HMR decisions; accepting, disposing, and reloading live behind these hooks.
     * @type {DevRuntimeHooks | null}
     */
    hooks: DevRuntimeHooks | null;
    /**
     * @param {ModuleGraphDelta} delta
     */
    registerGraph(delta: ModuleGraphDelta): void;
    /**
     * @param {string} id
     * @param {(id: string) => void} fn
     * @param {number} [stamp]
     */
    registerFactory(id: string, fn: (id: string) => void, stamp?: number): void;
    /**
     * @param {string} id
     * @param {{ exports: any }} [exportsHolder]
     * @param {boolean | 0 | 1} [isCommonJs]
     */
    registerModule(id: string, exportsHolder?: {
        exports: any;
    }, isCommonJs?: boolean | 0 | 1): void;
    /**
     * @param {string} id
     * @returns {string[]}
     */
    getImporters(id: string): string[];
    /**
     * `"*"` means the whole namespace, an empty list a side-effect-only import, `undefined` no edge.
     * @param {string} importer
     * @param {string} id
     * @returns {string[] | undefined}
     */
    getImportedBindings(importer: string, id: string): string[] | undefined;
    /**
     * @param {string} id
     */
    isEntry(id: string): any;
    /**
     * @param {string} id
     */
    isExecuted(id: string): any;
    /**
     * @param {string} id
     */
    hasFactory(id: string): any;
    /**
     * Module-cache delete only — static imports and factories persist. Removal is what
     * re-arms a cache-gated factory for `initModule`.
     * @param {string} id
     */
    removeModuleCache(id: string): void;
    /**
     * The one re-execution gate: registered → return the live exports; otherwise run the
     * mapped factory (which registers itself first, then runs the body).
     * @param {string} id
     */
    initModule(id: string): any;
    /**
     * @param {string} id
     */
    loadExports(id: string): any;
    /** @type {Map<string, Promise<any>>} */
    lazyRequests: Map<string, Promise<any>>;
    /**
     * The entry point for a lazy `import()`. `id` is the module the boundary stands for;
     * `proxyModuleId` is the boundary's own id, used only to load the chunk.
     *
     * Nothing is registered under the boundary id, deliberately. A cache entry with no factory
     * behind it reads as "executed" to the HMR boundary walk, and `applyUpdate` turns an
     * updated-but-factory-less module into a full page reload.
     *
     * A rejection is memoized like any other outcome, matching `import()` of a module that
     * threw. Retrying could not work anyway: a factory registers its module before running its
     * body, so re-running `initModule` would return half-initialized exports as success.
     *
     * A CommonJS module resolves to its `__toESM` view, as in a production build. The runtime
     * decides from the registration: the importer is compiled before the importee is in the
     * graph. `isNodeMode` is the importer's choice, so the view is built per call, not memoized.
     *
     * @param {string} id
     * @param {string} proxyModuleId
     * @param {boolean | 0 | 1} [isNodeMode]
     * @returns {Promise<any>}
     */
    requestLazy(id: string, proxyModuleId: string, isNodeMode?: boolean | 0 | 1): Promise<any>;
    /**
     * Whether `id` can run without the server: every module its run reaches through static
     * imports already ran or has a factory. A factory alone is not enough, because a patch
     * can ship a module without the static imports it never needed (#11028).
     * @internal
     * @param {string} id
     */
    isRunnableHere(id: string): boolean;
    /**
     * Loads the lazy chunk behind a lazy boundary. The chunk only registers factories;
     * `requestLazy` runs the module afterwards.
     *
     * The dev server owns the lazy endpoint, so a server that serves it at another URL (for
     * example under a public base path) overrides this method.
     *
     * @param {string} proxyModuleId
     * @returns {Promise<unknown>}
     */
    loadLazyChunk(proxyModuleId: string): Promise<unknown>;
    /**
     * @param {string} moduleId
     */
    createModuleHotContext(moduleId: string): any;
    /** @internal */
    __toESM: any;
    /** @internal */
    __toCommonJS: any;
    /** @internal */
    __exportAll: any;
    /** @internal */
    __reExport: any;
}
/**
 * Compiler-emitted module-graph delta — topology (static + dynamic edges).
 * `ids[0, localCount)` are the modules this payload carries; `ids[localCount, …)` are foreign edge targets.
 * `edges[i]` / `dynamicEdges[i]` are the static / dynamic-`import()` out-edges of `ids[i]`.
 * `bindings[i][j]` are the export names `ids[i]` imports through `edges[i][j]`. `bindings` holds
 * only some rows; a missing row, or a missing or `null` entry, means the whole namespace.
 * `dynamicEdges` also holds only some rows; a missing row means no dynamic edges.
 * `stamps[i]` is the rebuild stamp of `ids[i]`; a missing row means 0.
 * `entries` lists the rows whose module is an entry.
 */
export type ModuleGraphDelta = {
    ids: string[];
    localCount: number;
    edges: number[][];
    bindings?: Record<number, (string[] | null)[]>;
    dynamicEdges?: Record<number, number[]>;
    stamps?: Record<number, number>;
    entries?: number[];
};
/**
 * Compiler-emitted module-graph delta — topology (static + dynamic edges).
 * `ids[0, localCount)` are the modules this payload carries; `ids[localCount, …)` are foreign edge targets.
 * `edges[i]` / `dynamicEdges[i]` are the static / dynamic-`import()` out-edges of `ids[i]`.
 * `bindings[i][j]` are the export names `ids[i]` imports through `edges[i][j]`. `bindings` holds
 * only some rows; a missing row, or a missing or `null` entry, means the whole namespace.
 * `dynamicEdges` also holds only some rows; a missing row means no dynamic edges.
 * `stamps[i]` is the rebuild stamp of `ids[i]`; a missing row means 0.
 * `entries` lists the rows whose module is an entry.
 */
export type DevRuntimeHooks = {
    createModuleHotContext(moduleId: string): any;
    onModuleCacheRemoval(moduleId: string): void;
};
declare class Module {
    /**
     * @param {string} id
     */
    constructor(id: string);
    /**
     * @type {{ exports: any }}
     */
    exportsHolder: {
        exports: any;
    };
    /**
     * @type {string}
     */
    id: string;
    /**
     * A CommonJS module registers its raw `module.exports`; `requestLazy` builds the `__toESM`
     * view on top. ESM registers its namespace, used as is.
     * @type {boolean}
     */
    isCommonJs: boolean;
    get exports(): any;
}
export {};
