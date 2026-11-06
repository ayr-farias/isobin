// src/types/sourcemap.ts
function bindingifySourcemap(map) {
	if (map == null) return;
	return { inner: typeof map === "string" ? map : {
		file: map.file ?? void 0,
		mappings: map.mappings,
		sourceRoot: "sourceRoot" in map ? map.sourceRoot ?? void 0 : void 0,
		sources: map.sources?.map((s) => s ?? void 0),
		sourcesContent: map.sourcesContent?.map((s) => s ?? void 0),
		names: map.names,
		ignoreList: map.ignoreList,
		x_google_ignoreList: map.x_google_ignoreList,
		debugId: "debugId" in map ? map.debugId : void 0
	} };
}
// src/utils/module-id.ts
const ATTRIBUTES_MARKER_LENGTH = 12;
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
function stringifyModuleId(rawId, attributes) {
	if (!attributes) return rawId;
	const entries = Object.entries(attributes);
	if (entries.length === 0) return rawId;
	const sorted = Object.fromEntries(entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
	return `${rawId}${rawId.includes("?") ? "&" : "?"}attributes=${encodeURIComponent(JSON.stringify(sorted))}`;
}
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
function parseModuleId(id) {
	const markerIndex = Math.max(id.lastIndexOf("?attributes="), id.lastIndexOf("&attributes="));
	if (markerIndex !== -1) try {
		const rawId = id.slice(0, markerIndex);
		const attributes = JSON.parse(decodeURIComponent(id.slice(markerIndex + ATTRIBUTES_MARKER_LENGTH)));
		if (typeof attributes === "object" && attributes !== null && Object.values(attributes).every((value) => typeof value === "string") && stringifyModuleId(rawId, attributes) === id) return {
			rawId,
			attributes
		};
	} catch {}
	return {
		rawId: id,
		attributes: {}
	};
}
/** @internal */
function normalizeUniqueModuleId(id) {
	return typeof id === "object" ? {
		rawId: id.rawId,
		attributes: id.attributes ?? {}
	} : parseModuleId(id);
}
// src/utils/error.ts
function unwrapBindingResult(container) {
	if (typeof container === "object" && container !== null && "isBindingErrors" in container && container.isBindingErrors) throw aggregateBindingErrorsIntoJsError(container.errors);
	return container;
}
function normalizeBindingResult(container) {
	if (typeof container === "object" && container !== null && "isBindingErrors" in container && container.isBindingErrors) return aggregateBindingErrorsIntoJsError(container.errors);
	return container;
}
function normalizeBindingError(e) {
	return e.type === "JsError" ? e.field0 : Object.assign(/* @__PURE__ */ new Error(), {
		code: e.field0.kind,
		kind: e.field0.kind,
		message: e.field0.message,
		id: e.field0.id,
		plugin: e.field0.plugin,
		frame: e.field0.frame,
		exporter: e.field0.exporter,
		loc: e.field0.loc,
		pos: e.field0.pos,
		stack: void 0
	});
}
function aggregateBindingErrorsIntoJsError(rawErrors) {
	const errors = rawErrors.map(normalizeBindingError);
	let summary = `Build failed with ${errors.length} error${errors.length < 2 ? "" : "s"}:\n`;
	for (let i = 0; i < errors.length; i++) {
		summary += "\n";
		if (i >= 5) {
			summary += "...";
			break;
		}
		summary += getErrorMessage(errors[i]);
	}
	const wrapper = new Error(summary);
	Object.defineProperty(wrapper, "errors", {
		configurable: true,
		enumerable: true,
		get: () => errors,
		set: (value) => {
			Object.defineProperty(wrapper, "errors", {
				configurable: true,
				enumerable: true,
				value
			});
		}
	});
	return wrapper;
}
function getErrorMessage(e) {
	if (e === null || e === void 0) return `Error: ${String(e)}`;
	if (Object.hasOwn(e, "kind")) return e.message;
	let s = "";
	if (e.plugin) s += `[plugin ${e.plugin}]`;
	const id = e.id ?? e.loc?.file;
	if (id) {
		s += " " + id;
		if (e.loc) s += `:${e.loc.line}:${e.loc.column}`;
	}
	if (s) s += "\n";
	const message = `${e.name ?? "Error"}: ${e.message}`;
	s += message;
	if (e.frame) s = joinNewLine(s, e.frame);
	if (e.stack) s = joinNewLine(s, e.stack.replace(message, ""));
	if (e.cause) {
		s = joinNewLine(s, "Caused by:");
		s = joinNewLine(s, getErrorMessage(e.cause).split("\n").map((line) => "  " + line).join("\n"));
	}
	return s;
}
function joinNewLine(s1, s2) {
	return s1.replace(/\n+$/, "") + "\n" + s2.replace(/^\n+/, "");
}
export { normalizeUniqueModuleId as a, bindingifySourcemap as c, unwrapBindingResult as i, normalizeBindingError as n, parseModuleId as o, normalizeBindingResult as r, stringifyModuleId as s, aggregateBindingErrorsIntoJsError as t };
