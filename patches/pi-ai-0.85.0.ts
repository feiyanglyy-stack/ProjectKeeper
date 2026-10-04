/**
 * Exact npm 0.85.0 files, and the replacements ProjectKeeper makes in them. Each file's replacements apply in order;
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
export const version = '0.85.0';
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
  { path: 'dist/api/openai-completions.js', sha256: '1e2097ced37cf0e21aa5711297eecc77916de8a4ed81a9019bc7d97b22825fa3', replacements: [
    [jsonImport, deltaImport],
    ['block.partialArgs = (block.partialArgs ?? "") + toolCall.function.arguments;\n                                block.arguments = parseStreamingJson(block.partialArgs);',
     'block.partialArgs = (block.partialArgs ?? "") + toolCall.function.arguments;\n                                block.arguments = parseStreamingJsonDelta(block.partialArgs, block);'],
    [deltaImport, deltaImport + finalImport],
    ['block.arguments = parseStreamingJson(block.partialArgs);', 'block.arguments = finalizeStreamingToolArguments(block.partialArgs, block);'],
  ] },
  { path: 'dist/api/anthropic-messages.js', sha256: 'f748560c80fe91bb5736b62f6f34c5e2e2bfa224cd5eb959134ca903c226b604', replacements: [
    ['import { parseJsonWithRepair, parseStreamingJson }', 'import { parseJsonWithRepair, parseStreamingJson, parseStreamingJsonDelta }'],
    ['block.partialJson += event.delta.partial_json;\n                            block.arguments = parseStreamingJson(block.partialJson);',
     'block.partialJson += event.delta.partial_json;\n                            block.arguments = parseStreamingJsonDelta(block.partialJson, block);'],
    [anthropicDeltaImport, anthropicDeltaImport + finalImport],
    ['block.arguments = parseStreamingJson(block.partialJson);', 'block.arguments = finalizeStreamingToolArguments(block.partialJson, block);'],
  ] },
  { path: 'dist/api/bedrock-converse-stream.js', sha256: '13d6fec97d08f4303714aca50f3113ba0263706e961fc220ccb1cc023c520e6b', replacements: [
    [jsonImport, deltaImport],
    ['block.partialJson = (block.partialJson || "") + (delta.toolUse.input || "");\n        block.arguments = parseStreamingJson(block.partialJson);',
     'block.partialJson = (block.partialJson || "") + (delta.toolUse.input || "");\n        block.arguments = parseStreamingJsonDelta(block.partialJson, block);'],
    [deltaImport, deltaImport + finalImport],
    ['block.arguments = parseStreamingJson(block.partialJson);', 'block.arguments = finalizeStreamingToolArguments(block.partialJson, block);'],
  ] },
  { path: 'dist/api/mistral-conversations.js', sha256: '60c8a1589be1319dfa3a8d9fec4444a8aaa5c4015828e98312fc19a97ec1ab11', replacements: [
    [jsonImport, deltaImport],
    ['block.arguments = parseStreamingJson(block.partialArgs);', 'block.arguments = parseStreamingJsonDelta(block.partialArgs, block);'],
    [deltaImport, deltaImport + finalImport],
    ['toolBlock.arguments = parseStreamingJson(toolBlock.partialArgs);', 'toolBlock.arguments = finalizeStreamingToolArguments(toolBlock.partialArgs, toolBlock);'],
  ] },
  { path: 'dist/api/openai-responses-shared.js', sha256: 'b5d9f001e97bfafa8dfeef2e292f923c39f77fa8aef014132bf3530760f222e3', replacements: [
    [jsonImport, deltaImport],
    ['slot.block.partialJson += event.delta;\n            slot.block.arguments = parseStreamingJson(slot.block.partialJson);',
     'slot.block.partialJson += event.delta;\n            slot.block.arguments = parseStreamingJsonDelta(slot.block.partialJson, slot.block);'],
    [deltaImport, deltaImport + finalImport],
    // The provider's `function_call_arguments.done` carries the whole arguments; `output_item.done` finalizes them
    // again, and the later call decides whether the call is marked.
    ['slot.block.arguments = parseStreamingJson(slot.block.partialJson);', 'slot.block.arguments = finalizeStreamingToolArguments(slot.block.partialJson, slot.block);'],
    ['slot.block.arguments = parseStreamingJson(item.arguments || slot.block.partialJson || "{}");', 'slot.block.arguments = finalizeStreamingToolArguments(item.arguments || slot.block.partialJson || "{}", slot.block);'],
  ] },
  { path: 'dist/api/pi-messages.js', sha256: '0c866c9f1518020fa4a1eeb29e002b2d8bffd3bc4ac947f21f9023210ed911da', replacements: [
    [jsonImport, deltaImport],
    ['parseStreamingJson(json);', 'parseStreamingJsonDelta(json, partial.content[event.contentIndex]);'],
  ] },
];
