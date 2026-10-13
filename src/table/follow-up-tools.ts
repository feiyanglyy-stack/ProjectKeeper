/**
 * The table follow-up's one writer (D107): `pk_write_table` hands the whole updated table in. The program checks it as
 * `pk check` does, and either takes it in or refuses it with the list of problems. The work is done by the writer the
 * organizing service gives the runtime (keeper/organize/table-follow-up.ts `TableFollowUp.write`). This file only shapes
 * the call, so the runtime does not load the planner.
 */
import { Type } from 'typebox';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';

/** What the write answers: taken in, or refused with why. */
export interface TableWriteResult { readonly ok: boolean; readonly text: string }
/** Takes one version of the table in for one job: the table given, or else the job's working copy. */
export type TableWriter = (input: unknown) => Promise<TableWriteResult>;

export function tableFollowUpTools(writer: TableWriter, onTaken?: (text: string) => void): ToolDefinition[] {
  return [
    defineTool({
      name: 'pk_write_table', label: 'Hand the table in',
      description: 'Hand in the updated ProjectKeeper table. Leave `table` out to hand in your working copy (the file the brief names), which is the usual way: edit the copy, then call this. The program sets project.asOf and filledBy.agent/at, then checks the whole table: its shape, every id and reference, and every source against the project at that asOf. If anything fails, nothing is taken in and the answer lists each problem as `<where in the table>  <what is wrong>`: fix them all and call again. If it holds, the table is saved and taken in as the project\'s picture, and the answer says what changed.',
      parameters: Type.Object({
        table: Type.Optional(Type.Unknown({ description: 'the whole table as one JSON object (or its JSON text); leave out to hand in your working copy' })),
      }),
      execute: async (_id, p) => {
        const r = await writer((p as { table?: unknown }).table);
        if (r.ok) onTaken?.(r.text);
        return { content: [{ type: 'text' as const, text: r.ok ? r.text : `ERROR: ${r.text}` }], details: {}, ...(r.ok ? {} : { isError: true }) };
      },
    }) as unknown as ToolDefinition,
  ];
}
