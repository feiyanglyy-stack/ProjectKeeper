/**
 * Exact npm 0.87.1 files, and the replacements ProjectKeeper makes in them. Each file's replacements apply in order;
 * later generations append theirs after the earlier ones, so an installation an earlier generation patched is still
 * recognised and brought up to date (scripts/apply-pi-streaming-patch.ts `originalSource`).
 *
 * AO: delta parsing is throttled; the final parse of a tool call's arguments stays upstream's.
 * AX (QC AX-1, CKC-03 AC-30): the final parse accepts only complete JSON. Arguments that do not parse — a buffer cut
 * off mid-string, say — used to be completed by partial-json into a shorter value that could pass validation and run
 * (103 characters of markdown were written as 15). They are still kept for display and replay, but the call is marked,
 * and `validateToolArguments` refuses a marked call with a tool error before any tool — built-in, pk_* or an
 * extension's — runs, so the model is told to send it again in full.
 */
export const version = '0.87.1';
export interface PatchFile { path: string; sha256: string; replacements: [string, string][] }
const jsonImport = 'import { parseStreamingJson } from "../utils/json-parse.js";';
const deltaImport = 'import { parseStreamingJson, parseStreamingJsonDelta } from "../utils/json-parse.js";';
// AX adds its import as a line of its own, so the result of every replacement stays in the patched file exactly once.
const finalImport = '\nimport { finalizeStreamingToolArguments } from "../utils/json-parse.js";';
const anthropicDeltaImport = 'import { parseJsonWithRepair, parseStreamingJson, parseStreamingJsonDelta } from "../utils/json-parse.js";';
const parserImport = 'import { parse as partialParse } from "partial-json";';
const helper = `
// ProjectKeeper AO: amortize prefix repair across exponentially growing snapshots.
// Weak keys isolate interleaved calls and do not add scratch state to persisted messages.
const streamingJsonLengths = new WeakMap();
export function parseStreamingJsonDelta(partialJson, block) {
    const length = partialJson?.length ?? 0;
    const previous = streamingJsonLengths.get(block);
    if (previous !== undefined && length >= previous && length < Math.max(1024, previous * 2)) {
        return block.arguments;
    }
    streamingJsonLengths.set(block, length);
    return parseStreamingJson(partialJson);
}
`;
const sourceMap = '//# sourceMappingURL=json-parse.js.map';
const finalHelper = `// ProjectKeeper AX: a streamed tool call runs only on arguments that arrived as complete JSON (CKC-03 AC-30).
// The partial-json fallback completes a cut-off buffer into a shorter value that can pass validation (QC AX-1:
// 103 characters of markdown were written as 15). That value is kept for display and replay only: the call is
// marked with a symbol (never serialized into sessions or requests), and validateToolArguments refuses it.
const incompleteToolArguments = Symbol.for("projectkeeper.pi-ai.incompleteToolArguments");
export function finalizeStreamingToolArguments(partialJson, block) {
    delete block[incompleteToolArguments];
    if (!partialJson || partialJson.trim() === "") {
        return {};
    }
    try {
        return parseJsonWithRepair(partialJson);
    }
    catch (error) {
        const reason = (error instanceof Error ? error.message : String(error)).replace(/\\s*\\(line \\d+ column \\d+\\)$/, "");
        block[incompleteToolArguments] = { length: partialJson.length, reason };
        return parseStreamingJson(partialJson);
    }
}
export function incompleteToolArgumentsError(toolCall) {
    const incomplete = toolCall?.[incompleteToolArguments];
    if (!incomplete) {
        return undefined;
    }
    return \`Tool call "\${toolCall.name}" was not executed: its arguments did not arrive as complete JSON, so they may have been cut off. Nothing was run; send the call again with the complete arguments. (\${incomplete.length} characters arrived; \${incomplete.reason})\`;
}
`;
const valueImport = 'import { Value } from "typebox/value";';
const validateHead = 'export function validateToolArguments(tool, toolCall) {\n    const args = structuredClone(toolCall.arguments);';

export const files: PatchFile[] = [
  { path: 'dist/utils/json-parse.js', sha256: '824fa2bf05b37d65b105ac8c07172d19f22f56a4ac66fbffba943933e4fb6d62', replacements: [
    [parserImport, parserImport + '\n' + helper],
    [sourceMap, finalHelper + sourceMap],
  ] },
  { path: 'dist/utils/validation.js', sha256: '25448fb499e38cd216b4a47d747ddf3b7750419d379e4bf4ca1578ada48d04d7', replacements: [
    [valueImport, valueImport + '\nimport { incompleteToolArgumentsError } from "./json-parse.js";'],
    [validateHead, 'export function validateToolArguments(tool, toolCall) {\n'
      + '    // ProjectKeeper AX: arguments that did not arrive as complete JSON never reach a tool (json-parse.js).\n'
      + '    const incomplete = incompleteToolArgumentsError(toolCall);\n'
      + '    if (incomplete) {\n'
      + '        throw new Error(incomplete);\n'
      + '    }\n'
      + '    const args = structuredClone(toolCall.arguments);'],
  ] },
  { path: 'dist/api/openai-completions.js', sha256: 'a2397cb3114a3d1a05993f6f19671ecbcc85540d8f8c59a233808c717df2682c', replacements: [
    [jsonImport, deltaImport],
    ['block.partialArgs = (block.partialArgs ?? "") + toolCall.function.arguments;\n                                block.arguments = parseStreamingJson(block.partialArgs);',
     'block.partialArgs = (block.partialArgs ?? "") + toolCall.function.arguments;\n                                block.arguments = parseStreamingJsonDelta(block.partialArgs, block);'],
    [deltaImport, deltaImport + finalImport],
    ['block.arguments = parseStreamingJson(block.partialArgs);', 'block.arguments = finalizeStreamingToolArguments(block.partialArgs, block);'],
  ] },
  { path: 'dist/api/anthropic-messages.js', sha256: '97de17d406264322ff7927fa0c20e1c61b46386b5e14f9c6e0012599c01664f7', replacements: [
    ['import { parseJsonWithRepair, parseStreamingJson }', 'import { parseJsonWithRepair, parseStreamingJson, parseStreamingJsonDelta }'],
    ['block.partialJson += event.delta.partial_json;\n                            block.arguments = parseStreamingJson(block.partialJson);',
     'block.partialJson += event.delta.partial_json;\n                            block.arguments = parseStreamingJsonDelta(block.partialJson, block);'],
    [anthropicDeltaImport, anthropicDeltaImport + finalImport],
    ['block.arguments = parseStreamingJson(block.partialJson);', 'block.arguments = finalizeStreamingToolArguments(block.partialJson, block);'],
  ] },
  { path: 'dist/api/bedrock-converse-stream.js', sha256: '47d08990180cce57c49bdb5f81daa0971b13f5ce77fe5762d9d41ff0d0b9551d', replacements: [
    [jsonImport, deltaImport],
    ['block.partialJson = (block.partialJson || "") + (delta.toolUse.input || "");\n        block.arguments = parseStreamingJson(block.partialJson);',
     'block.partialJson = (block.partialJson || "") + (delta.toolUse.input || "");\n        block.arguments = parseStreamingJsonDelta(block.partialJson, block);'],
    [deltaImport, deltaImport + finalImport],
    ['block.arguments = parseStreamingJson(block.partialJson);', 'block.arguments = finalizeStreamingToolArguments(block.partialJson, block);'],
  ] },
  { path: 'dist/api/mistral-conversations.js', sha256: 'beea0b191eaf33f0b412fb0c10219fac89a599fba9c4f215a1fcfd5ea8c3f46e', replacements: [
    [jsonImport, deltaImport],
    ['block.arguments = parseStreamingJson(block.partialArgs);', 'block.arguments = parseStreamingJsonDelta(block.partialArgs, block);'],
    [deltaImport, deltaImport + finalImport],
    ['toolBlock.arguments = parseStreamingJson(toolBlock.partialArgs);', 'toolBlock.arguments = finalizeStreamingToolArguments(toolBlock.partialArgs, toolBlock);'],
  ] },
  { path: 'dist/api/openai-responses-shared.js', sha256: '7846279b34c2a569bda2b0753c8b083f8b976204b4fdd7586095ebbb6a643410', replacements: [
    [jsonImport, deltaImport],
    ['slot.block.partialJson += event.delta;\n            slot.block.arguments = parseStreamingJson(slot.block.partialJson);',
     'slot.block.partialJson += event.delta;\n            slot.block.arguments = parseStreamingJsonDelta(slot.block.partialJson, slot.block);'],
    [deltaImport, deltaImport + finalImport],
    // The provider's `function_call_arguments.done` carries the whole arguments; `output_item.done` finalizes them
    // again, and the later call decides whether the call is marked.
    ['slot.block.arguments = parseStreamingJson(slot.block.partialJson);', 'slot.block.arguments = finalizeStreamingToolArguments(slot.block.partialJson, slot.block);'],
    ['slot.block.arguments = parseStreamingJson(item.arguments || slot.block.partialJson || "{}");', 'slot.block.arguments = finalizeStreamingToolArguments(item.arguments || slot.block.partialJson || "{}", slot.block);'],
  ] },
  { path: 'dist/api/pi-messages.js', sha256: 'f88b2bca1317b6fc7600cad90900fb60483c18db4afa234928b3e08b121d36bd', replacements: [
    [jsonImport, deltaImport],
    ['parseStreamingJson(json);', 'parseStreamingJsonDelta(json, partial.content[event.contentIndex]);'],
  ] },
];
