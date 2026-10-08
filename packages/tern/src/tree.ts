import { EngineError, type SemanticNode, type ViewportSize } from 'e2e/engine';

export interface NativeAx {
  readonly id?: number;
  readonly role?: string;
  readonly name?: string;
  readonly value?: string | number;
  readonly placeholder?: string;
  readonly description?: string;
  readonly states?: readonly string[];
  readonly level?: number;
  readonly bounds?: readonly number[];
  readonly children?: readonly NativeAx[];
}
export interface NativeElement {
  readonly id?: string;
  readonly class?: string;
  readonly text?: string;
  readonly rect?: readonly number[];
  readonly input?: { readonly value?: string; readonly focused?: boolean; readonly type?: string; readonly secure?: boolean };
  readonly children?: readonly NativeElement[];
}
export interface NativeDump {
  readonly path: string;
  readonly nth: string;
  readonly rect: readonly number[];
  readonly visible: boolean;
}
const roles: Readonly<Record<string, string>> = {
  Window: 'window', Button: 'button', TextInput: 'textbox', MultilineTextInput: 'textbox', TextField: 'textbox', TextBox: 'textbox', Editor: 'textbox', PasswordInput: 'textbox',
  SearchField: 'searchbox', Switch: 'switch', CheckBox: 'checkbox', RadioButton: 'radio', RadioGroup: 'radiogroup',
  ComboBox: 'combobox', ListBox: 'listbox', Link: 'link', Tab: 'tab', MenuItem: 'menuitem', Meter: 'meter', Slider: 'slider',
  Heading: 'heading', Group: 'group', Region: 'region', StaticText: 'text',
};

/** Bounds equality accommodates the native layout's single-pixel rounding. */
function sameBox(a: readonly number[], b: readonly number[]): boolean {
  return a.length === 4 && b.length === 4 && a.every((value, index) => Number.isFinite(value) && Math.abs(value - b[index]!) <= 1);
}

/** Flatten for addressing; the observation itself retains its hierarchy. */
export function flatten<T extends { readonly children?: readonly T[] }>(nodes: readonly T[]): T[] {
  const result: T[] = [];
  const visit = (node: T): void => { result.push(node); for (const child of node.children ?? []) visit(child); };
  for (const node of nodes) visit(node);
  return result;
}

/** Native values are factual, hidden state uses the same predicate locators see. */
export function semanticTree(ax: NativeAx, elements: readonly NativeElement[], dump: readonly NativeDump[], viewport: ViewportSize): SemanticNode {
  const dom = flatten(elements);
  const seen = new Set<string>();
  const lift = (node: NativeAx): SemanticNode[] => {
    const children = (node.children ?? []).flatMap(lift);
    if (node.id === undefined) return children;
    const id = `ax:${node.id}`;
    if (seen.has(id)) throw new EngineError('ENGINE_FAILURE', 'Tern returned duplicate accessibility ids', { retryable: false });
    seen.add(id);
    const bounds = node.bounds;
    const valid = bounds?.length === 4 && bounds.every(Number.isFinite);
    const states = node.states ?? [];
    const inputs = valid ? dom.filter(item => item.input && item.rect && sameBox(item.rect, bounds)) : [];
    if(inputs.length>1) throw new EngineError('ENGINE_FAILURE','Native input metadata is ambiguous',{retryable:false});
    const element=inputs[0];
    const password=states.includes('password')||/password/i.test(node.role??'')||element?.input?.type==='password';
    const secure=password||states.includes('protected')||element?.input?.secure===true;
    if(!secure&&element?.input?.value!==undefined&&node.value!==undefined&&String(node.value)!==element.input.value) throw new EngineError('ENGINE_FAILURE','Native AX and rendered input values disagree',{retryable:false});
    const value = element?.input?.value ?? node.value;
    const intrinsicallyHidden=!valid||bounds[2]!<=0||bounds[3]!<=0||states.includes('hidden')||states.includes('invisible');
    const hidden = intrinsicallyHidden || bounds![0]! < 0 || bounds![1]! < 0
      || bounds![0]! + bounds![2]! > viewport.width + 1 || bounds![1]! + bounds![3]! > viewport.height + 1
      || !dump.some(item => item.visible && sameBox(item.rect, bounds!));
    return [{
      ref: { id, revision: '' }, role: password ? 'textbox' : roles[node.role ?? ''] ?? 'generic',
      ...(node.name === undefined ? {} : { name: node.name }),
      ...(password ? { inputPurpose: 'password' as const } : {}),
      ...(!secure && value !== undefined ? { value: String(value) } : {}),
      ...(valid ? { rect: { x: bounds[0]!, y: bounds[1]!, width: bounds[2]!, height: bounds[3]! } } : {}),
      ...(node.level === undefined ? {} : { level: node.level }),
      attributes: { 'native-hidden': String(intrinsicallyHidden), ...(node.placeholder === undefined ? {} : { placeholder: node.placeholder }), ...(node.description === undefined ? {} : { description: node.description }) },
      states: { hidden, secure,
        ...(states.includes('checked') ? { checked: true } : states.includes('unchecked') ? { checked: false } : {}),
        ...(states.includes('selected') ? { selected: true } : {}), ...(states.includes('disabled') ? { disabled: true } : {}),
        ...(states.includes('expanded') ? { expanded: true } : states.includes('collapsed') ? { expanded: false } : {}),
        ...(states.includes('focused') || element?.input?.focused ? { focused: true } : {}),
      }, children,
    }];
  };
  return { ref: { id: 'root', revision: '' }, role: 'window', children: lift(ax) };
}

/** A raw nth address is ephemeral: mint it only from this action's fresh snapshot. */
export function actionSelector(node: SemanticNode, dump: readonly NativeDump[], scroll = false): string {
  if ((!scroll && node.states?.hidden) || (scroll && node.attributes?.['native-hidden'] === 'true') || node.states?.disabled || !node.rect) throw new EngineError('NOT_ACTIONABLE', 'Native control is not addressable and enabled', { retryable: false });
  const { x, y, width, height } = node.rect;
  const matches = dump.filter(item => (scroll || item.visible) && sameBox(item.rect, [x, y, width, height]));
  const deepest = matches.filter(item => !matches.some(other => other !== item && other.path.startsWith(`${item.path}>`)));
  if (deepest.length !== 1) throw new EngineError('NOT_ACTIONABLE', 'Native control does not have one unique current DOM address', { retryable: false });
  return deepest[0]!.nth;
}

/** Targeted fills must not inherit a different editor after an app focus redirect. */
export function focusedEditable(root: SemanticNode, intendedId?: string): SemanticNode {
  const nodes=flatten([root]).filter(node=>node.states?.focused&&['textbox','searchbox'].includes(node.role??''));
  if(nodes.length!==1||(intendedId!==undefined&&nodes[0]!.ref.id!==intendedId)) throw new EngineError('NOT_ACTIONABLE','The intended unique editable native control does not have focus',{retryable:false});
  return nodes[0]!;
}
