import { defineRule, type ESTree, type Scope } from '@oxlint/plugins';

/** The expression under parentheses, `await`, `!`, and optional chaining. */
function unwrap(expression: ESTree.Expression): ESTree.Expression {
  let current = expression;
  while (true) {
    if (current.type === 'AwaitExpression') current = current.argument;
    else if (current.type === 'ParenthesizedExpression' || current.type === 'TSNonNullExpression' || current.type === 'ChainExpression') {
      current = current.expression;
    } else return current;
  }
}

/** True for a call of `<object>.<name>(...)`. */
function isMethodCall(node: ESTree.Expression, name: string): node is ESTree.CallExpression & { callee: ESTree.MemberExpression } {
  return (
    node.type === 'CallExpression' &&
    node.callee.type === 'MemberExpression' &&
    !node.callee.computed &&
    node.callee.property.type === 'Identifier' &&
    node.callee.property.name === name
  );
}

/**
 * True for parsed JSON, typed `any`: `JSON.parse(...)`, `x.json()`, and
 * `x.json()` through `.catch(...)` or `.then((r) => r.json())`. A `.json(body)`
 * call builds a response rather than reading one.
 */
function isJson(expression: ESTree.Expression): boolean {
  const node = unwrap(expression);
  if (isMethodCall(node, 'parse')) return node.callee.object.type === 'Identifier' && node.callee.object.name === 'JSON';
  if (isMethodCall(node, 'catch')) return node.callee.object.type !== 'Super' && isJson(node.callee.object);
  if (isMethodCall(node, 'then')) {
    const [callback] = node.arguments;
    return callback?.type === 'ArrowFunctionExpression' && callback.body.type !== 'BlockStatement' && isJson(callback.body);
  }
  return isMethodCall(node, 'json') && node.arguments.length === 0;
}

/** True for `unknown`, or a promise of it: the only honest types for unparsed JSON. */
function isUnknown(type: ESTree.TSType | undefined): boolean {
  if (type === undefined) return false;
  if (type.type === 'TSUnknownKeyword') return true;
  if (type.type !== 'TSTypeReference' || type.typeName.type !== 'Identifier') return false;
  if (type.typeName.name !== 'Promise' && type.typeName.name !== 'PromiseLike') return false;
  const params = type.typeArguments?.params;
  return params?.length === 1 && params[0]?.type === 'TSUnknownKeyword';
}

/** The type the binding `name` was declared with, looked up from `scope` outward. */
function declaredType(scope: Scope | null, name: string): ESTree.TSType | undefined {
  for (let current = scope; current !== null; current = current.upper) {
    const binding = current.set.get(name)?.defs[0]?.name;
    if (binding !== undefined) return 'typeAnnotation' in binding ? binding.typeAnnotation?.typeAnnotation : undefined;
  }
  return undefined;
}

/** The function a `return` inside `node` returns from. */
function enclosingFunction(node: ESTree.Node): ESTree.Function | ESTree.ArrowFunctionExpression | undefined {
  for (let current: ESTree.Node | null = node.parent; current !== null; current = current.parent) {
    if (current.type === 'FunctionDeclaration' || current.type === 'FunctionExpression' || current.type === 'ArrowFunctionExpression') {
      return current;
    }
  }
  return undefined;
}

/** True for a function passed inline to a call, such as `.then((r) => r.json())`, which the call's own landing site types. */
function isCallback(fn: ESTree.Function | ESTree.ArrowFunctionExpression): boolean {
  const { parent } = fn;
  return (parent.type === 'CallExpression' || parent.type === 'NewExpression') && parent.arguments.some((argument) => argument === fn);
}

/** Requires parsed JSON to be typed `unknown` wherever it lands, so it is parsed or narrowed before use. */
export const noUncheckedJson = defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Require parsed JSON to be typed `unknown` until a schema or a check narrows it.' },
    messages: {
      unchecked: 'Typing parsed JSON does not check it. Parse it with a schema, or type it `unknown` and narrow it.',
    },
  },
  createOnce(context) {
    const report = (node: ESTree.Node) => context.report({ node, messageId: 'unchecked' });
    const checkAssertion = (node: ESTree.TSAsExpression | ESTree.TSTypeAssertion) => {
      if (!isUnknown(node.typeAnnotation) && isJson(node.expression)) report(node);
    };
    const checkReturn = (fn: ESTree.Function | ESTree.ArrowFunctionExpression | undefined, value: ESTree.Expression) => {
      if (fn === undefined || isUnknown(fn.returnType?.typeAnnotation) || !isJson(value)) return;
      if (fn.returnType === null && isCallback(fn)) return;
      report(value);
    };
    return {
      TSAsExpression: checkAssertion,
      TSTypeAssertion: checkAssertion,
      VariableDeclarator(node) {
        if (node.init !== null && !isUnknown(node.id.typeAnnotation?.typeAnnotation) && isJson(node.init)) report(node.init);
      },
      AssignmentExpression(node) {
        if (node.left.type !== 'Identifier' || !isJson(node.right)) return;
        if (!isUnknown(declaredType(context.sourceCode.getScope(node), node.left.name))) report(node.right);
      },
      ReturnStatement(node) {
        if (node.argument !== null) checkReturn(enclosingFunction(node), node.argument);
      },
      ArrowFunctionExpression(node) {
        if (node.body.type !== 'BlockStatement') checkReturn(node, node.body);
      },
    };
  },
});
