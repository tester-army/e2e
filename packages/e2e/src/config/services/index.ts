/**
 * Run-wide service resolution. Every process a run may start is one
 * service: a `defineService` handle a target lists (with every service it
 * depends on), or the process a target's `app.command` is (`app:<target>`,
 * which no `defineService` name can spell). `collect` orders the handles,
 * `template` checks each into a template where `{port}` is the process's own
 * port and every placeholder names an address it may read, and `bind`
 * substitutes the run's ports into the templates and nothing else.
 */

export * from './model.ts';
export * from './collect.ts';
export * from './template.ts';
export * from './bind.ts';
