// Adapted from anti-slop (https://github.com/dmmulroy/anti-slop),
// Copyright (c) 2026 Dillon Mulroy, MIT License (see LICENSE-anti-slop).

import { defineRule, type ESTree } from '@oxlint/plugins';

type TypeAssertion = ESTree.TSAsExpression | ESTree.TSTypeAssertion;

/** True for an `x as T` or `<T>x` expression. */
function isTypeAssertion(node: ESTree.Node): node is TypeAssertion {
  return node.type === 'TSAsExpression' || node.type === 'TSTypeAssertion';
}

/** The expression under any wrapping parentheses. */
function unwrapParentheses(expression: ESTree.Expression): ESTree.Expression {
  let current = expression;
  while (current.type === 'ParenthesizedExpression') current = current.expression;
  return current;
}

/** True for `as const`. */
function isConstAssertion(node: TypeAssertion): boolean {
  const { typeAnnotation } = node;
  return (
    typeAnnotation.type === 'TSTypeReference' &&
    typeAnnotation.typeName.type === 'Identifier' &&
    typeAnnotation.typeName.name === 'const'
  );
}

/** True when no assertion wraps this one, so a chain is reported once. */
function isOutermost(node: TypeAssertion): boolean {
  let current: ESTree.Expression = node;
  let parent = node.parent;
  while (parent.type === 'ParenthesizedExpression' && parent.expression === current) {
    current = parent;
    parent = parent.parent;
  }
  return !isTypeAssertion(parent) || parent.expression !== current;
}

/** True for two or more nested assertions that are not all `as const`. */
function isChain(node: TypeAssertion): boolean {
  let count = 0;
  let allConst = true;
  let current: ESTree.Expression = node;
  while (isTypeAssertion(current)) {
    count += 1;
    allConst &&= isConstAssertion(current);
    current = unwrapParentheses(current.expression);
  }
  return count > 1 && !allConst;
}

/** Disallows nested type assertions such as `x as unknown as T`; chains of only `as const` pass. */
export const noChainedTypeAssertions = defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Disallow chained `as` and angle-bracket type assertions.' },
    messages: {
      chained:
        'Chained assertions skip the compiler check. Keep the precise type, narrow with a type guard, or parse the value at its boundary.',
    },
  },
  createOnce(context) {
    const check = (node: TypeAssertion) => {
      if (isOutermost(node) && isChain(node)) context.report({ node, messageId: 'chained' });
    };
    return { TSAsExpression: check, TSTypeAssertion: check };
  },
});
