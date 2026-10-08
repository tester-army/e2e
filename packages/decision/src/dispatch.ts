import type { StepExecutorContext } from 'e2e';
import type { Control, Operation, Target } from './elements.ts';
import type { Point } from './overlay.ts';
/** What an operation takes beside its target: typed text, a secret name, upload paths, a drop target, or a point. */
export type Argument =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'secret'; readonly name: string }
  | { readonly kind: 'paths'; readonly paths: readonly string[] }
  | { readonly kind: 'destination'; readonly id: string }
  | { readonly kind: 'point'; readonly point: Point }
  | { readonly kind: 'none' };
/** One action the loop dispatches: an operation on a target, or a control. */
export type Action =
  | { readonly operation: Operation; readonly target: Target; readonly argument: Argument }
  | { readonly operation: Control };
/**
 * Performs one action through the runner's grammar: the only place that
 * touches `ctx.actions`. Resolves to a note for the model when the engine
 * reports something worth telling it, nothing otherwise.
 */
export async function perform(ctx: StepExecutorContext, action: Action): Promise<string | undefined> {
  const { actions } = ctx;
  if (!('target' in action)) {
    switch (action.operation) {
      case 'scroll_up':
        await actions.scroll('up');
        return undefined;
      case 'scroll_down':
        await actions.scroll('down');
        return undefined;
      case 'back':
        await actions.back();
        return undefined;
    }
  }
  const { operation, target, argument } = action;
  const node = { id: target.id };
  switch (operation) {
    case 'tap':
      await actions.tap(node);
      return undefined;
    case 'double_tap':
      await actions.doubleTap(node);
      return undefined;
    case 'long_press':
      await actions.longPress(node);
      return undefined;
    case 'hover':
      await actions.hover(node);
      return undefined;
    case 'secondary_tap':
      await actions.secondaryTap(node);
      return undefined;
    case 'scroll_to':
      await actions.scrollTo(node);
      return undefined;
    case 'submit':
      await actions.press(node, 'Enter');
      return undefined;
    case 'check':
      await actions.check(node, !(target.checked ?? false));
      return undefined;
    case 'select':
      await actions.select(node, target.optionLabel ?? '');
      return undefined;
    case 'type':
      await actions.type(node, expect(argument, 'text').text);
      return undefined;
    case 'typeSecret':
      await actions.typeSecret(node, expect(argument, 'secret').name);
      return undefined;
    case 'upload':
      await actions.upload(node, expect(argument, 'paths').paths);
      return undefined;
    case 'drag':
      await actions.drag(node, { id: expect(argument, 'destination').id });
      return undefined;
    case 'tap_at': {
      // The engine's prose for a bare point ("no listed control is there")
      // reads as a miss to a classifier; whether the page changed says more.
      const result = await actions.tapAt(expect(argument, 'point').point);
      return result.target === undefined ? undefined : `landed on listed control ${result.target.id}`;
    }
  }
}
/** The argument an operation needs; its absence is the loop's bug, never the model's. */
function expect<K extends Argument['kind']>(argument: Argument, kind: K): Extract<Argument, { kind: K }> {
  if (argument.kind !== kind) throw new Error(`${kind} argument expected, got ${argument.kind}`);
  return argument as Extract<Argument, { kind: K }>;
}
