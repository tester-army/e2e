import type { StepExecutorContext } from 'e2e';
import type { Control, Target } from './elements.ts';
import type { Point } from './overlay.ts';
/** Operations that take a target and nothing else. */
export type Pointer = 'tap' | 'double_tap' | 'long_press' | 'hover' | 'secondary_tap' | 'scroll_to' | 'submit' | 'check' | 'select';
/** One action the loop dispatches, with everything its operation needs. */
export type Action =
  | { readonly operation: Pointer; readonly target: Target }
  | { readonly operation: 'type'; readonly target: Target; readonly text: string }
  | { readonly operation: 'typeSecret'; readonly target: Target; readonly name: string }
  | { readonly operation: 'upload'; readonly target: Target; readonly paths: readonly string[] }
  | { readonly operation: 'drag'; readonly target: Target; readonly destinationId: string }
  | { readonly operation: 'tap_at'; readonly point: Point }
  | { readonly operation: Control };
/**
 * Performs one action through the runner's grammar: the only place that
 * touches `ctx.actions`. Resolves to a note for the model when the engine
 * reports something worth telling it, nothing otherwise.
 */
export async function perform(ctx: StepExecutorContext, action: Action): Promise<string | undefined> {
  const { actions } = ctx;
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
    case 'tap':
      await actions.tap(node(action.target));
      return undefined;
    case 'double_tap':
      await actions.doubleTap(node(action.target));
      return undefined;
    case 'long_press':
      await actions.longPress(node(action.target));
      return undefined;
    case 'hover':
      await actions.hover(node(action.target));
      return undefined;
    case 'secondary_tap':
      await actions.secondaryTap(node(action.target));
      return undefined;
    case 'scroll_to':
      await actions.scrollTo(node(action.target));
      return undefined;
    case 'submit':
      await actions.press(node(action.target), 'Enter');
      return undefined;
    case 'check':
      await actions.check(node(action.target), !(action.target.checked ?? false));
      return undefined;
    case 'select':
      await actions.select(node(action.target), action.target.optionLabel ?? '');
      return undefined;
    case 'type':
      await actions.type(node(action.target), action.text);
      return undefined;
    case 'typeSecret':
      await actions.typeSecret(node(action.target), action.name);
      return undefined;
    case 'upload':
      await actions.upload(node(action.target), action.paths);
      return undefined;
    case 'drag':
      await actions.drag(node(action.target), { id: action.destinationId });
      return undefined;
    case 'tap_at': {
      // The engine's prose for a bare point ("no listed control is there")
      // reads as a miss to a classifier; whether the page changed says more.
      const result = await actions.tapAt(action.point);
      return result.target === undefined ? undefined : `landed on listed control ${result.target.id}`;
    }
  }
}
function node(target: Target): { id: string } {
  return { id: target.id };
}
