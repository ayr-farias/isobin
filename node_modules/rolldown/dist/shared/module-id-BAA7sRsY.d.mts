/**
 * A module id, or the raw id and import attributes it is built from.
 *
 * @category Plugin APIs
 */
type UniqueModuleId = string | {
  rawId: string;
  attributes?: Record<string, string>;
};
/**
 * Builds the module id of `rawId` imported with `attributes`. Without attributes it is `rawId`
 * itself.
 *
 * @example
 * ```js
 * stringifyModuleId('/src/a.json', { type: 'json' });
 * // → '/src/a.json?attributes=%7B%22type%22%3A%22json%22%7D'
 * ```
 *
 * @category Utilities
 */
declare function stringifyModuleId(rawId: string, attributes?: Record<string, string>): string;
/**
 * Splits a module id into the raw id and the import attributes it was built from.
 *
 * Only an id in the exact format that Rolldown uses is split. Any other id, e.g.
 * `virtual?attributes=foo`, is returned as the raw id with no attributes. See
 * [Module ids](https://rolldown.rs/in-depth/import-attributes#module-ids) for the format.
 *
 * @example
 * ```js
 * parseModuleId('/src/a.json?attributes=%7B%22type%22%3A%22json%22%7D');
 * // → { rawId: '/src/a.json', attributes: { type: 'json' } }
 * parseModuleId('/src/a.js?raw');
 * // → { rawId: '/src/a.js?raw', attributes: {} }
 * ```
 *
 * @category Utilities
 */
declare function parseModuleId(id: string): {
  rawId: string;
  attributes: Record<string, string>;
};
export { parseModuleId as n, stringifyModuleId as r, UniqueModuleId as t };