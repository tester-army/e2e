/**
 * The focuses of parallel explorers (`--parallel <n>`): every explorer gets
 * the whole goal and one focus, so several explorers spread over different
 * kinds of defects rather than over different areas of the app. Explorer i
 * takes the i-th focus of the list, in its order.
 */

/** One explorer's focus: a label for the reporters and the record, and the text the planner and the explorer read. */
export interface ExploreFocus {
  readonly label: string;
  readonly text: string;
}

const CORE: ExploreFocus = {
  label: 'core flows',
  text: 'the core flows end to end: create, edit, open, close, and delete records, and check the copy, counts, dates, and states each screen shows afterwards, on every screen that lists the same records.',
};

const INPUT: ExploreFocus = {
  label: 'edge-case input',
  text: 'edge-case input and validation: whitespace-only, duplicate, very long unbroken, accented, emoji, and special-character text (%, _, quotes, <tags>), boundary numbers and dates, submitting twice quickly, and what a failed validation keeps or drops.',
};

const STATE: ExploreFocus = {
  label: 'state across screens',
  text: 'state across controls and screens: combine filters, sorting, search, paging, and tabs and check earlier choices are kept; check sort direction; reload and go back; rename or delete something other screens refer to and revisit those screens.',
};

const LAYOUT_CHECKS = 'check the main screens with long names, and at tablet and phone widths when a resize_viewport tool is offered, for overlap, clipping, and controls that become unreachable.';

const CONTENT: ExploreFocus = {
  label: 'content and controls',
  text: 'content and controls: use every toolbar button, keyboard shortcut, and option each screen advertises; compare rich text or formatted previews with the saved result; follow links between records, including to names with special characters; check uploads and downloads.',
};

/**
 * The focuses of `count` explorers, in order. The fourth looks at another
 * account's view too, but only when another account is there to sign in
 * with: more than one configured and no saved session pinning the run to one.
 */
export function exploreFocuses(count: number, options: { readonly otherAccount: boolean }): readonly ExploreFocus[] {
  const layouts: ExploreFocus = options.otherAccount
    ? {
        label: 'layouts and roles',
        text: `layouts and roles: ${LAYOUT_CHECKS} Then sign in as another of the configured accounts and check what each role can see and do.`,
      }
    : { label: 'layouts', text: `layouts: ${LAYOUT_CHECKS}` };
  return [CORE, INPUT, STATE, layouts, CONTENT].slice(0, count);
}

/** The `Focus:` line the planner and the explorer read beside the goal. */
export function focusContext(focus: ExploreFocus): string {
  return [
    `Focus: ${focus.text}`,
    'Other explorers work toward the same goal at the same time with other focuses, so every step serves this one.',
    'They use the same app and the same accounts, so records, carts, and settings can change under you: work on records you create, and never report as a defect a change another explorer could have made.',
  ].join(' ');
}
