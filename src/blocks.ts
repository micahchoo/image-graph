/**
 * The fenced block that would draw what is on screen.
 *
 * Written once here and read once in `embed.ts`, so the two cannot drift: the round trip is
 * the test. Only what differs from the default is written, because a block is text somebody
 * then edits, and four lines they did not ask for are four lines to read past.
 */
export interface BlockView {path: string | null; relation: string | null; depth: number; height?: number}

export const BLOCK_LANGUAGE = 'image-graph';

export function noteBlock(view: BlockView): string {
 const lines: string[] = [];
 if (view.path) lines.push(`[[${view.path}]]`);
 if (view.relation) lines.push(`relation: ${view.relation}`);
 else if (view.depth !== 1) lines.push(`depth: ${view.depth}`);
 if (view.height !== undefined) lines.push(`height: ${view.height}`);
 return ['```' + BLOCK_LANGUAGE, ...lines, '```'].join('\n');
}
