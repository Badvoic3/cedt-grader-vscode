/** Line rules shared by the compare and the diff. No imports: the Test view's page bundles this. */

const END_SPACE = /[ \t\f\v]+$/;

/** A line as the compare sees it: nothing at its end, every run of spaces one space. */
export const normalizeLine = (raw: string): string => raw.replace(END_SPACE, '').replace(/[ \t\f\v]+/g, ' ');

/** A line's spaces at the end, which don't count but should be seen. */
export const trailOf = (raw: string): string => END_SPACE.exec(raw)?.[0] ?? '';
