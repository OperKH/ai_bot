/**
 * The GraphQL a persisted query's hash takes (psStoreHash.ts): the executable documents — operations and fragments —
 * parsed into a small AST, Apollo's `__typename` added, the AST sorted, and printed exactly as graphql-js 14 prints
 * them, whose `print` the PS Store's client hashes with (graphql-js is MIT; its printer's rules are followed here). A
 * later `print` wraps long lists of arguments, and its hash is another. The type system's definitions and block
 * strings are not supported: a template that has them is skipped.
 */

export type Value =
  | { kind: 'Variable'; name: string }
  | { kind: 'IntValue' | 'FloatValue' | 'EnumValue'; value: string }
  | { kind: 'StringValue'; value: string }
  | { kind: 'BooleanValue'; value: boolean }
  | { kind: 'NullValue' }
  | { kind: 'ListValue'; values: Value[] }
  | { kind: 'ObjectValue'; fields: { name: string; value: Value }[] };

export type TypeRef = { kind: 'NamedType'; name: string } | { kind: 'ListType' | 'NonNullType'; type: TypeRef };

export interface Argument {
  name: string;
  value: Value;
}

export interface Directive {
  name: string;
  arguments: Argument[];
}

export interface VariableDefinition {
  variable: string;
  type: TypeRef;
  defaultValue: Value | null;
  directives: Directive[];
}

export type Selection =
  | { kind: 'Field'; alias: string | null; name: string; arguments: Argument[]; directives: Directive[]; selectionSet: Selection[] | null }
  | { kind: 'FragmentSpread'; name: string; directives: Directive[] }
  | { kind: 'InlineFragment'; typeCondition: string | null; directives: Directive[]; selectionSet: Selection[] };

export type Definition =
  | {
      kind: 'OperationDefinition';
      operation: 'query' | 'mutation' | 'subscription';
      name: string | null;
      variableDefinitions: VariableDefinition[];
      directives: Directive[];
      selectionSet: Selection[];
    }
  | { kind: 'FragmentDefinition'; name: string; typeCondition: string; directives: Directive[]; selectionSet: Selection[] };

// Lexing

type Token = { kind: 'punct' | 'name' | 'int' | 'float' | 'string'; value: string };

const PUNCTUATORS = new Set(['!', '$', '&', '(', ')', ':', '=', '@', '[', ']', '{', '|', '}']);
const NAME = /[_A-Za-z][_0-9A-Za-z]*/y;
const NUMBER = /-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/y;
const ESCAPES: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

function tokens(source: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    // Whitespace, commas and the byte-order mark are insignificant, so is a comment to the end of its line
    if (' \t\n\r,﻿'.includes(ch)) {
      i++;
    } else if (ch === '#') {
      while (i < source.length && source[i] !== '\n' && source[i] !== '\r') i++;
    } else if (source.startsWith('...', i)) {
      out.push({ kind: 'punct', value: '...' });
      i += 3;
    } else if (PUNCTUATORS.has(ch)) {
      out.push({ kind: 'punct', value: ch });
      i++;
    } else if (ch === '"') {
      if (source.startsWith('"""', i)) throw new Error('block strings are not supported');
      let value = '';
      i++;
      for (;;) {
        const c = source[i];
        if (c === undefined || c === '\n' || c === '\r') throw new Error('unterminated string');
        if (c === '"') break;
        if (c === '\\') {
          const e = source[i + 1];
          if (e === 'u') {
            value += String.fromCharCode(parseInt(source.slice(i + 2, i + 6), 16));
            i += 6;
          } else if (e in ESCAPES) {
            value += ESCAPES[e];
            i += 2;
          } else {
            throw new Error(`bad escape \\${e}`);
          }
        } else {
          value += c;
          i++;
        }
      }
      i++;
      out.push({ kind: 'string', value });
    } else if (/[-0-9]/.test(ch)) {
      NUMBER.lastIndex = i;
      const match = NUMBER.exec(source);
      if (!match) throw new Error(`bad number at ${i}`);
      out.push({ kind: match[2] || match[3] ? 'float' : 'int', value: match[0] });
      i += match[0].length;
    } else {
      NAME.lastIndex = i;
      const match = NAME.exec(source);
      if (!match) throw new Error(`unexpected «${ch}» at ${i}`);
      out.push({ kind: 'name', value: match[0] });
      i += match[0].length;
    }
  }
  return out;
}

// Parsing

class Parser {
  private at = 0;

  constructor(private readonly tokens: Token[]) {}

  document(): Definition[] {
    const definitions: Definition[] = [];
    while (this.at < this.tokens.length) definitions.push(this.definition());
    return definitions;
  }

  private peek(value?: string, kind: Token['kind'] = 'punct'): boolean {
    const token = this.tokens[this.at];
    return token !== undefined && token.kind === kind && (value === undefined || token.value === value);
  }

  private next(): Token {
    const token = this.tokens[this.at++];
    if (!token) throw new Error('unexpected end of the document');
    return token;
  }

  private expect(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected «${value}», got «${token.value}»`);
  }

  private name(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name, got «${token.value}»`);
    return token.value;
  }

  private keyword(word: string): void {
    if (this.name() !== word) throw new Error(`expected «${word}»`);
  }

  private definition(): Definition {
    if (this.peek('{')) {
      return { kind: 'OperationDefinition', operation: 'query', name: null, variableDefinitions: [], directives: [], selectionSet: this.selectionSet() };
    }
    const word = this.name();
    if (word === 'fragment') {
      const name = this.name();
      this.keyword('on');
      return { kind: 'FragmentDefinition', name, typeCondition: this.name(), directives: this.directives(), selectionSet: this.selectionSet() };
    }
    if (word !== 'query' && word !== 'mutation' && word !== 'subscription') throw new Error(`«${word}» is no executable definition`);
    const name = this.peek(undefined, 'name') ? this.name() : null;
    const variableDefinitions: VariableDefinition[] = [];
    if (this.peek('(')) {
      this.expect('(');
      while (!this.peek(')')) {
        this.expect('$');
        const variable = this.name();
        this.expect(':');
        const type = this.type();
        let defaultValue: Value | null = null;
        if (this.peek('=')) {
          this.expect('=');
          defaultValue = this.value(true);
        }
        variableDefinitions.push({ variable, type, defaultValue, directives: this.directives() });
      }
      this.expect(')');
    }
    return { kind: 'OperationDefinition', operation: word, name, variableDefinitions, directives: this.directives(), selectionSet: this.selectionSet() };
  }

  private type(): TypeRef {
    let type: TypeRef;
    if (this.peek('[')) {
      this.expect('[');
      type = { kind: 'ListType', type: this.type() };
      this.expect(']');
    } else {
      type = { kind: 'NamedType', name: this.name() };
    }
    if (this.peek('!')) {
      this.expect('!');
      type = { kind: 'NonNullType', type };
    }
    return type;
  }

  private selectionSet(): Selection[] {
    this.expect('{');
    const selections: Selection[] = [];
    while (!this.peek('}')) selections.push(this.selection());
    this.expect('}');
    return selections;
  }

  private selection(): Selection {
    if (this.peek('...')) {
      this.expect('...');
      if (this.peek(undefined, 'name') && this.tokens[this.at].value !== 'on') {
        return { kind: 'FragmentSpread', name: this.name(), directives: this.directives() };
      }
      let typeCondition: string | null = null;
      if (this.peek('on', 'name')) {
        this.keyword('on');
        typeCondition = this.name();
      }
      return { kind: 'InlineFragment', typeCondition, directives: this.directives(), selectionSet: this.selectionSet() };
    }
    let alias: string | null = null;
    let name = this.name();
    if (this.peek(':')) {
      this.expect(':');
      alias = name;
      name = this.name();
    }
    return {
      kind: 'Field',
      alias,
      name,
      arguments: this.arguments(false),
      directives: this.directives(),
      selectionSet: this.peek('{') ? this.selectionSet() : null,
    };
  }

  private arguments(isConst: boolean): Argument[] {
    if (!this.peek('(')) return [];
    this.expect('(');
    const args: Argument[] = [];
    while (!this.peek(')')) {
      const name = this.name();
      this.expect(':');
      args.push({ name, value: this.value(isConst) });
    }
    this.expect(')');
    return args;
  }

  private directives(): Directive[] {
    const directives: Directive[] = [];
    while (this.peek('@')) {
      this.expect('@');
      directives.push({ name: this.name(), arguments: this.arguments(false) });
    }
    return directives;
  }

  private value(isConst: boolean): Value {
    const token = this.next();
    if (token.kind === 'punct') {
      if (token.value === '$' && !isConst) return { kind: 'Variable', name: this.name() };
      if (token.value === '[') {
        const values: Value[] = [];
        while (!this.peek(']')) values.push(this.value(isConst));
        this.expect(']');
        return { kind: 'ListValue', values };
      }
      if (token.value === '{') {
        const fields: { name: string; value: Value }[] = [];
        while (!this.peek('}')) {
          const name = this.name();
          this.expect(':');
          fields.push({ name, value: this.value(isConst) });
        }
        this.expect('}');
        return { kind: 'ObjectValue', fields };
      }
      throw new Error(`unexpected «${token.value}» in a value`);
    }
    if (token.kind === 'int') return { kind: 'IntValue', value: token.value };
    if (token.kind === 'float') return { kind: 'FloatValue', value: token.value };
    if (token.kind === 'string') return { kind: 'StringValue', value: token.value };
    if (token.value === 'true' || token.value === 'false') return { kind: 'BooleanValue', value: token.value === 'true' };
    if (token.value === 'null') return { kind: 'NullValue' };
    return { kind: 'EnumValue', value: token.value };
  }
}

/** The definitions of an executable document; a syntax error, or what is not supported, throws */
export function parseDocument(source: string): Definition[] {
  return new Parser(tokens(source)).document();
}

// Apollo's `__typename` and the persisted-query link's sorting

const TYPENAME: Selection = { kind: 'Field', alias: null, name: '__typename', arguments: [], directives: [], selectionSet: null };

/** Every selection but an operation's own asks for `__typename`, unless it asks for a meta field already */
function typed(selections: Selection[], root: boolean): Selection[] {
  const inner = selections.map((selection): Selection => {
    if (selection.kind === 'Field') return { ...selection, selectionSet: selection.selectionSet && typed(selection.selectionSet, false) };
    if (selection.kind === 'InlineFragment') return { ...selection, selectionSet: typed(selection.selectionSet, false) };
    return selection;
  });
  if (root || inner.some((s) => s.kind === 'Field' && s.name.startsWith('__'))) return inner;
  return [...inner, TYPENAME];
}

export function withTypename(definitions: Definition[]): Definition[] {
  return definitions.map((definition) => ({
    ...definition,
    selectionSet: typed(definition.selectionSet, definition.kind === 'OperationDefinition'),
  }));
}

/** Sorted as lodash's `sortBy` sorts: stable, by the keys in turn */
function sortedBy<T>(items: readonly T[], ...keys: ((item: T) => string)[]): T[] {
  return [...items].sort((a, b) => {
    for (const key of keys) {
      const [x, y] = [key(a), key(b)];
      if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  });
}

const byName = <T extends { name: string }>(items: readonly T[]) => sortedBy(items, (item) => item.name);
/** A directive's arguments are sorted wherever it stands; the order of the directives only where the link sorts them */
const withSortedArguments = (directives: readonly Directive[]) =>
  directives.map((directive) => ({ ...directive, arguments: byName(directive.arguments) }));
const sortDirectives = (directives: readonly Directive[]) => byName(withSortedArguments(directives));

/**
 * The persisted-query link's sorting: the definitions and the selections by kind and name, the variables, the
 * arguments; the directives of spreads, inline fragments and fragments — not of fields and operations
 */
function sortSelections(selections: readonly Selection[]): Selection[] {
  return sortedBy(
    selections.map((selection): Selection => {
      if (selection.kind === 'Field') {
        return {
          ...selection,
          arguments: byName(selection.arguments),
          directives: withSortedArguments(selection.directives),
          selectionSet: selection.selectionSet && sortSelections(selection.selectionSet),
        };
      }
      if (selection.kind === 'InlineFragment') {
        return { ...selection, directives: sortDirectives(selection.directives), selectionSet: sortSelections(selection.selectionSet) };
      }
      return { ...selection, directives: sortDirectives(selection.directives) };
    }),
    (s) => s.kind,
    (s) => (s.kind === 'InlineFragment' ? '' : s.name),
  );
}

export function sortDocument(definitions: readonly Definition[]): Definition[] {
  return sortedBy(
    definitions.map((definition): Definition =>
      definition.kind === 'OperationDefinition'
        ? {
            ...definition,
            variableDefinitions: sortedBy(definition.variableDefinitions, (v) => v.variable).map((v) => ({
              ...v,
              directives: withSortedArguments(v.directives),
            })),
            directives: withSortedArguments(definition.directives),
            selectionSet: sortSelections(definition.selectionSet),
          }
        : { ...definition, directives: sortDirectives(definition.directives), selectionSet: sortSelections(definition.selectionSet) },
    ),
    (d) => d.kind,
    (d) => d.name ?? '',
  );
}

// Printing, by graphql-js 14's rules

const join = (items: readonly string[], separator = '') => items.filter(Boolean).join(separator);
const wrap = (start: string, inner: string, end = '') => (inner ? start + inner + end : '');
const indent = (text: string) => text && `  ${text.replace(/\n/g, '\n  ')}`;
const block = (items: readonly string[]) => (items.length > 0 ? `{\n${indent(join(items, '\n'))}\n}` : '');

function printValue(value: Value): string {
  switch (value.kind) {
    case 'Variable':
      return `$${value.name}`;
    case 'StringValue':
      return JSON.stringify(value.value);
    case 'BooleanValue':
      return value.value ? 'true' : 'false';
    case 'NullValue':
      return 'null';
    case 'ListValue':
      return `[${join(value.values.map(printValue), ', ')}]`;
    case 'ObjectValue':
      return `{${join(value.fields.map((field) => `${field.name}: ${printValue(field.value)}`), ', ')}}`;
    default:
      return value.value;
  }
}

function printType(type: TypeRef): string {
  if (type.kind === 'NamedType') return type.name;
  return type.kind === 'ListType' ? `[${printType(type.type)}]` : `${printType(type.type)}!`;
}

const printArguments = (args: readonly Argument[]) => wrap('(', join(args.map((a) => `${a.name}: ${printValue(a.value)}`), ', '), ')');
const printDirectives = (directives: readonly Directive[]) => join(directives.map((d) => `@${d.name}${printArguments(d.arguments)}`), ' ');

function printSelection(selection: Selection): string {
  if (selection.kind === 'Field') {
    return join(
      [
        wrap('', selection.alias ?? '', ': ') + selection.name + printArguments(selection.arguments),
        printDirectives(selection.directives),
        selection.selectionSet ? block(selection.selectionSet.map(printSelection)) : '',
      ],
      ' ',
    );
  }
  if (selection.kind === 'FragmentSpread') return `...${selection.name}${wrap(' ', printDirectives(selection.directives))}`;
  return join(['...', wrap('on ', selection.typeCondition ?? ''), printDirectives(selection.directives), block(selection.selectionSet.map(printSelection))], ' ');
}

function printDefinition(definition: Definition): string {
  const selectionSet = block(definition.selectionSet.map(printSelection));
  const directives = printDirectives(definition.directives);
  if (definition.kind === 'FragmentDefinition') {
    return `fragment ${definition.name} on ${definition.typeCondition} ${wrap('', directives, ' ')}${selectionSet}`;
  }
  const variables = wrap(
    '(',
    join(
      definition.variableDefinitions.map(
        (v) =>
          `$${v.variable}: ${printType(v.type)}${v.defaultValue ? ` = ${printValue(v.defaultValue)}` : ''}${wrap(' ', printDirectives(v.directives))}`,
      ),
      ', ',
    ),
    ')',
  );
  if (!definition.name && !directives && !variables && definition.operation === 'query') return selectionSet;
  return join([definition.operation, join([definition.name ?? '', variables]), directives, selectionSet], ' ');
}

/** The document as graphql-js 14 prints it */
export function printDocument(definitions: readonly Definition[]): string {
  return `${join(definitions.map(printDefinition), '\n\n')}\n`;
}

/** The fragments a definition spreads, its own and those of its inline fragments */
export function spreadsOf(selections: readonly Selection[]): string[] {
  return selections.flatMap((selection) => {
    if (selection.kind === 'FragmentSpread') return [selection.name];
    const inner = selection.kind === 'Field' ? selection.selectionSet : selection.selectionSet;
    return inner ? spreadsOf(inner) : [];
  });
}
