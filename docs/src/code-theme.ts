/**
 * The TesterArmy code theme: a warm near-black surface with the brand orange as
 * the hero keyword color, balanced by a few distinct hues so token categories
 * stay easy to tell apart. Mirrors `apps/website/lib/blog/code-theme.ts` in the
 * tester-army repository.
 */
export const testerArmyCodeTheme = {
  name: 'testerarmy-dark',
  type: 'dark',
  colors: {
    'editor.background': '#1a1a1a',
    'editor.foreground': '#e4e2dd',
  },
  tokenColors: [
    {
      settings: {
        background: '#1a1a1a',
        foreground: '#e4e2dd',
      },
    },
    {
      scope: ['comment', 'punctuation.definition.comment', 'string.comment'],
      settings: { foreground: '#7a756c', fontStyle: 'italic' },
    },
    {
      scope: [
        'keyword',
        'keyword.control',
        'keyword.operator.expression',
        'storage.type',
        'storage.modifier',
        'keyword.other',
      ],
      settings: { foreground: '#ff8a1f' },
    },
    {
      scope: ['string', 'string.quoted', 'string.template', 'punctuation.definition.string'],
      settings: { foreground: '#a8cf87' },
    },
    {
      scope: [
        'constant.numeric',
        'constant.language',
        'constant.language.boolean',
        'support.constant',
      ],
      settings: { foreground: '#c8a8ff' },
    },
    {
      scope: [
        'entity.name.function',
        'support.function',
        'meta.function-call entity.name.function',
        'variable.function',
      ],
      settings: { foreground: '#ffcf6a' },
    },
    {
      scope: [
        'entity.name.type',
        'entity.name.class',
        'support.type',
        'support.class',
        'entity.other.inherited-class',
      ],
      settings: { foreground: '#5fcfc0' },
    },
    {
      scope: ['variable', 'variable.other', 'variable.parameter', 'meta.definition.variable'],
      settings: { foreground: '#e4e2dd' },
    },
    {
      scope: ['variable.other.property', 'support.variable.property', 'meta.object-literal.key'],
      settings: { foreground: '#7fd4ea' },
    },
    {
      scope: [
        'punctuation',
        'meta.brace',
        'keyword.operator',
        'punctuation.separator',
        'punctuation.terminator',
      ],
      settings: { foreground: '#a39e94' },
    },
    {
      scope: ['entity.name.tag', 'punctuation.definition.tag'],
      settings: { foreground: '#ff8a1f' },
    },
    {
      scope: ['entity.other.attribute-name'],
      settings: { foreground: '#ffcf6a' },
    },
    {
      scope: ['string.regexp', 'constant.character.escape'],
      settings: { foreground: '#5fcfc0' },
    },
    {
      scope: ['invalid', 'invalid.illegal'],
      settings: { foreground: '#ff5d5d' },
    },
  ],
};
