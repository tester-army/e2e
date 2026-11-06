/**
 * The keyboard and mouse of one attempt's tab: the only sender of input,
 * WebDriver BiDi `input.performActions` and Chromium's CDP input commands
 * alike, and the keeper of what that input leaves behind (the keys and
 * buttons held, where the mouse is) and of how much input went out.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Protocol } from 'devtools-protocol';
import type { Input } from 'webdriver-bidi-protocol';
import { TestError, type ViewportPoint, type ViewportSize } from 'e2e/engine';
import { ChromiumCdp } from './cdp.ts';
import { chromiumKeyCommands, holdsAfter, type CdpKeyCommand } from './chromium-keys.ts';
import type { BidiConnection } from './connection.ts';
import { codeOfValue, MODIFIER_CODES, pressStroke, strokeSource, type KeyStroke, type Modifier } from './keyboard.ts';
import type { BidiBrowserName } from './launch.ts';

/** A key held down, and how: a BiDi key action with its value, which its release repeats, or a CDP key event, which only CDP releases. */
type HeldKey = { readonly via: 'bidi'; readonly value: string } | { readonly via: 'cdp' };

/** What the input reaches the tab through. */
export interface InputTarget {
  readonly connection: BidiConnection;
  readonly browser: BidiBrowserName;
  /** The tab input goes to; throws when none is open. */
  readonly context: () => string;
  /** The viewport in CSS pixels, which every pointer target must lie in. */
  readonly viewport: () => Promise<ViewportSize>;
}

/** The input state of one tab, which the browser keeps between calls and the driver mirrors. */
class InputState {
  constructor(
    /** The keys held, by layout `code`. */
    readonly keys = new Map<string, HeldKey>(),
    /** The mouse buttons held. */
    readonly buttons = new Set<number>(),
    /** Where the mouse last moved. */
    public pointer: ViewportPoint = { x: 0, y: 0 },
  ) {}

  /** A copy to stage the effect of input on before the browser takes it. */
  copy(): InputState {
    return new InputState(new Map(this.keys), new Set(this.buttons), this.pointer);
  }

  /** The modifiers held, on either side. */
  modifiers(): Set<Modifier> {
    const held = new Set<Modifier>();
    for (const code of this.keys.keys()) {
      const modifier = MODIFIER_CODES.get(code);
      if (modifier !== undefined) held.add(modifier);
    }
    return held;
  }
}

/** Input sends and page mutations: those read back (`counted`) and suppressible sends whose verdict is still out (`undecided`), which count until it says otherwise. */
interface DispatchCount {
  counted: number;
  undecided: number;
}

const operationDispatches = new AsyncLocalStorage<DispatchCount>();

/**
 * One operation's own dispatch count, so whether it sent input that may have
 * reached the app is read off its own sends: input or an evaluate another
 * operation runs meanwhile does not count.
 */
export class DispatchScope {
  private readonly count: DispatchCount = { counted: 0, undecided: 0 };

  /** Runs `work` with every input send and page mutation it makes counted here too. */
  run<T>(work: () => Promise<T>): Promise<T> {
    return operationDispatches.run(this.count, work);
  }

  /** Whether `run`'s work sent input or changed the page, or has a send whose verdict is still out. */
  get dispatched(): boolean {
    return this.count.counted + this.count.undecided > 0;
  }
}

/** The keyboard and mouse of one attempt's tab. */
export class BidiInput {
  private state = new InputState();
  private readonly total: DispatchCount = { counted: 0, undecided: 0 };
  private cdpSession: { readonly context: string; readonly cdp: Promise<ChromiumCdp> } | undefined;

  constructor(private readonly target: InputTarget) {}

  /** Input sends and page mutations so far: an action that fails after this moved may have reached the app. */
  get dispatches(): number {
    return this.total.counted + this.total.undecided;
  }

  /** Where the mouse last moved, which a viewport swipe wheels at. */
  get pointer(): ViewportPoint {
    return this.state.pointer;
  }

  /** Counts a change the driver or the test's code made in the page (a fill, a select, an evaluate), which may have reached the app. */
  mutated(): void {
    this.count('counted', 1);
  }

  /** Adds `delta` to the attempt's count and to the count of the operation running it (`dispatchScope`). */
  private count(kind: keyof DispatchCount, delta: number): void {
    this.total[kind] += delta;
    const scope = operationDispatches.getStore();
    if (scope !== undefined) scope[kind] += delta;
  }

  /** Forgets everything held and where the mouse was, with the tab that held them. */
  reset(): void {
    this.state = new InputState();
    this.cdpSession = undefined;
  }

  /**
   * Runs input sources on the tab. A pointer target outside the viewport is
   * refused before anything is sent. A modifier already held is neither
   * pressed nor released again, a key is released with the value that
   * pressed it, and a move while a button is down carries pressure. The
   * state the input leaves is recorded once the browser took it. Nothing is
   * sent once `signal` aborted.
   */
  async send(actions: readonly Input.SourceActions[], signal?: AbortSignal): Promise<void> {
    const { sent, after } = await this.prepare(actions, signal);
    this.count('counted', 1);
    await this.perform(sent);
    this.state = after;
  }

  /**
   * Runs input sources the page may suppress before any listener of the app
   * sees them (the hit interceptor of a click), then reads `verdict`. The
   * input counts as dispatched from the moment it goes out until the
   * verdict, if `suppressed` says the page swallowed it, takes that back; a
   * send or verdict that fails, or never settles, leaves it counted. A failed
   * send throws once the verdict is read.
   */
  async sendSuppressible<V>(actions: readonly Input.SourceActions[], signal: AbortSignal, verdict: () => Promise<V>, suppressed: (verdict: V) => boolean): Promise<V> {
    const { sent, after } = await this.prepare(actions, signal);
    this.count('undecided', 1);
    let swallowed = false;
    try {
      let failure: { cause: unknown } | undefined;
      try {
        await this.perform(sent);
        this.state = after;
      } catch (cause) {
        failure = { cause };
      }
      let read: V;
      try {
        read = await verdict();
      } catch (cause) {
        throw failure === undefined ? cause : failure.cause;
      }
      if (failure !== undefined) throw failure.cause;
      swallowed = suppressed(read);
      return read;
    } finally {
      this.count('undecided', -1);
      if (!swallowed) this.count('counted', 1);
    }
  }

  /** Presses one key of the contract grammar (`pressStroke`). */
  press(key: string, signal?: AbortSignal): Promise<void> {
    return this.key(pressStroke(key), signal);
  }

  /**
   * Presses, holds, or releases one key: as CDP key events on Chromium when
   * a BiDi key action cannot carry it (`chromiumKeyCommands`), else as a
   * BiDi key action. Either path sees the modifiers the other holds, and a
   * key is released the way it was pressed.
   */
  key(stroke: KeyStroke, signal?: AbortSignal): Promise<void> {
    const modifiers = this.state.modifiers();
    if (this.target.browser === 'chromium') {
      const pressed = new Set([...this.state.keys].filter(([, held]) => held.via === 'cdp').map(([code]) => code));
      const commands = chromiumKeyCommands(stroke, { held: modifiers, pressed, mac: process.platform === 'darwin' });
      if (commands !== undefined) return this.sendCdpKeys(commands, signal);
    }
    return this.send([strokeSource(stroke, modifiers.has('Shift'))], signal);
  }

  /** Turns Chromium's drag interception on or off (`Input.setInterceptDrags`). */
  async interceptDrags(enabled: boolean): Promise<void> {
    await (await this.cdp()).send('Input.setInterceptDrags', { enabled });
  }

  /** Listens for the drag Chromium intercepted, with the data the page set; returns the unsubscribe. */
  async onDragIntercepted(handler: (data: Protocol.Input.DragData) => void): Promise<() => void> {
    return (await this.cdp()).on('Input.dragIntercepted', (event) => handler(event.data));
  }

  /** Dispatches one event of an intercepted drag at a viewport point (`Input.dispatchDragEvent`); the drag pointer is there after it. */
  async dragEvent(type: Protocol.Input.DispatchDragEventRequest['type'], point: ViewportPoint, data: Protocol.Input.DragData, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await this.checkInViewport([point]);
    const cdp = await this.cdp();
    this.count('counted', 1);
    await cdp.send('Input.dispatchDragEvent', { type, x: point.x, y: point.y, data });
    this.state.pointer = { x: point.x, y: point.y };
  }

  /**
   * Sends CDP key commands to the tab's target in order, recording the keys
   * each leaves held. Nothing is sent once `signal` aborted; once the first
   * went out the rest follow, so a chord never leaves a modifier held.
   */
  private async sendCdpKeys(commands: readonly CdpKeyCommand[], signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const cdp = await this.cdp();
    signal?.throwIfAborted();
    this.count('counted', 1);
    for (const command of commands) {
      await cdp.send(command.method, command.params);
      const held = holdsAfter(command);
      if (held?.down === true) this.state.keys.set(held.code, { via: 'cdp' });
      else if (held?.down === false) this.state.keys.delete(held.code);
    }
  }

  /** CDP on the tab's target, one session per tab. */
  private cdp(): Promise<ChromiumCdp> {
    const context = this.target.context();
    if (this.cdpSession?.context !== context) {
      const cdp = ChromiumCdp.forContext(this.target.connection, context);
      this.cdpSession = { context, cdp };
      cdp.catch(() => {
        if (this.cdpSession?.cdp === cdp) this.cdpSession = undefined;
      });
    }
    return this.cdpSession.cdp;
  }

  /** The sources as they go out, and the state they leave once the browser took them; refuses a pointer target outside the viewport. */
  private async prepare(actions: readonly Input.SourceActions[], signal: AbortSignal | undefined): Promise<{ sent: Input.SourceActions[]; after: InputState }> {
    signal?.throwIfAborted();
    this.target.context();
    await this.checkInViewport(actions.flatMap(targets));
    signal?.throwIfAborted();
    const after = this.state.copy();
    const sent = actions.map((source) => (source.type === 'key' ? keepHeld(source, after) : source.type === 'pointer' ? withPressure(source, after) : source));
    return { sent, after };
  }

  /** Sends sources to the tab. */
  private async perform(actions: Input.SourceActions[]): Promise<void> {
    await this.target.connection.send('input.performActions', { context: this.target.context(), actions });
  }

  /**
   * Refuses a pointer target outside the viewport as WebDriver bounds it,
   * from 0 to its width and height inclusive, before any input goes out:
   * BiDi cannot move the pointer off the page, and the browsers differ on
   * what they reject.
   */
  private async checkInViewport(points: readonly ViewportPoint[]): Promise<void> {
    if (points.length === 0) return;
    const { width, height } = await this.target.viewport();
    const outside = points.find(({ x, y }) => x < 0 || y < 0 || x > width || y > height);
    if (outside !== undefined) {
      throw new TestError('INVALID_ARGUMENT', `the pointer target (${String(outside.x)}, ${String(outside.y)}) is outside the ${String(width)}x${String(height)} viewport; WebDriver BiDi moves the pointer only within it`);
    }
  }
}

/** The viewport points a source moves the pointer to or wheels at. */
function targets(source: Input.SourceActions): ViewportPoint[] {
  if (source.type === 'pointer') return source.actions.flatMap((action) => (action.type === 'pointerMove' ? [{ x: action.x, y: action.y }] : []));
  if (source.type === 'wheel') return source.actions.flatMap((action) => (action.type === 'scroll' ? [{ x: action.x, y: action.y }] : []));
  return [];
}

/**
 * A key source with the modifiers already held left alone, so one a
 * `keyboard.down` holds stays held through a chord or a modifier click, and
 * each release sent with the value its key was pressed with; a press or
 * release left out becomes a pause, so the source keeps its ticks beside a
 * pointer's. Records in `state` what stays held after it.
 */
function keepHeld(source: Input.KeySourceActions, state: InputState): Input.KeySourceActions {
  const skipped = new Set<string>();
  const kept = source.actions.map((action): Input.KeySourceAction => {
    if (action.type !== 'keyDown' && action.type !== 'keyUp') return action;
    const code = codeOfValue(action.value);
    const held = state.keys.get(code);
    if (action.type === 'keyDown') {
      if (MODIFIER_CODES.has(code) && held !== undefined) {
        skipped.add(code);
        return { type: 'pause' };
      }
      state.keys.set(code, { via: 'bidi', value: action.value });
      return action;
    }
    if (skipped.has(code)) return { type: 'pause' };
    state.keys.delete(code);
    return held?.via === 'bidi' ? { type: 'keyUp', value: held.value } : action;
  });
  return { ...source, actions: kept };
}

/**
 * A mouse source with the pressure a held button gives: 0.5 on a press and
 * on every move while a button is down, as a real mouse reports it, so a
 * page reading `PointerEvent.pressure` sees the same. Records in `state`
 * which buttons stay held and where the mouse ends.
 */
function withPressure(source: Input.PointerSourceActions, state: InputState): Input.PointerSourceActions {
  const actions = source.actions.map((action): Input.PointerSourceAction => {
    if (action.type === 'pointerDown') {
      state.buttons.add(action.button);
      return { pressure: 0.5, ...action };
    }
    if (action.type === 'pointerUp') state.buttons.delete(action.button);
    if (action.type !== 'pointerMove') return action;
    state.pointer = { x: action.x, y: action.y };
    return state.buttons.size > 0 ? { pressure: 0.5, ...action } : action;
  });
  return { ...source, actions };
}
