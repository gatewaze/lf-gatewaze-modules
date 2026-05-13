/**
 * Parse a Sanity schema .ts file into our `ParsedSanitySchema` shape.
 *
 * Approach: ts-morph static analysis. We look for `defineType({...})`
 * exported from the file, then walk the AST to extract:
 *   - name, title, type, groups
 *   - fields[] from the `fields:` array (incl. defineField wrapper)
 *   - For each field: name, type, title, description, options, validation,
 *     hidden, group, initialValue, fields (nested object), of (array members)
 *
 * Limitations:
 *   - Custom validation `Rule.custom(fn => ...)` is recorded as opaque
 *     source text. The mapper drops it.
 *   - `hidden` callbacks are best-effort: only the common pattern
 *     `({parent}) => parent.field !== 'value'` is extracted.
 *   - Field-set spreads like `...visibilityFields` are resolved when
 *     the imported symbol is available at parse time — otherwise we
 *     skip the spread with a warning.
 *
 * This is enough for the AAIF Sanity codebase as audited.
 */

import { Project, SyntaxKind } from 'ts-morph';
import type {
  Node,
  ObjectLiteralExpression,
  PropertyAssignment,
  Expression,
  SourceFile,
} from 'ts-morph';
import type {
  ParsedSanityField,
  ParsedSanitySchema,
  ParsedArrayMember,
  ParsedFieldOptions,
  ParsedValidation,
  SanityFieldType,
} from './sanity-types.js';

export interface ParseOptions {
  /**
   * Pre-resolved field-set spreads keyed by import name.
   * Example: `{ visibilityFields: [...fields] }` lets the parser
   * inline `...visibilityFields` rather than emit a warning.
   */
  knownFieldSets?: Record<string, ParsedSanityField[]>;
  /** Filenames the project is aware of, so cross-file imports resolve. */
  tsConfigFilePath?: string;
}

export interface ParseResult {
  schema: ParsedSanitySchema;
  warnings: ReadonlyArray<{ location: string; reason: string }>;
}

export function parseSanitySchemaFile(filePath: string, opts: ParseOptions = {}): ParseResult {
  const project = new Project({
    ...(opts.tsConfigFilePath ? { tsConfigFilePath: opts.tsConfigFilePath } : { compilerOptions: { allowJs: true, jsx: 1 } }),
    skipAddingFilesFromTsConfig: true,
  });
  const sourceFile = project.addSourceFileAtPath(filePath);
  return parseSourceFile(sourceFile, opts);
}

export function parseSanitySchemaString(text: string, virtualPath = 'in-memory.ts', opts: ParseOptions = {}): ParseResult {
  const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { allowJs: true, jsx: 1 } });
  const sourceFile = project.createSourceFile(virtualPath, text);
  return parseSourceFile(sourceFile, opts);
}

// ---------------------------------------------------------------------------

function parseSourceFile(sourceFile: SourceFile, opts: ParseOptions): ParseResult {
  const warnings: Array<{ location: string; reason: string }> = [];
  const defineCall = findDefineTypeCall(sourceFile);
  if (!defineCall) {
    throw new Error(`no defineType(...) call found in ${sourceFile.getFilePath()}`);
  }
  const obj = getCallObjectArg(defineCall);
  if (!obj) {
    throw new Error(`defineType() called without an object literal in ${sourceFile.getFilePath()}`);
  }
  const schema = parseDefineTypeObject(obj, opts, warnings);
  return { schema, warnings };
}

function findDefineTypeCall(sourceFile: SourceFile): Expression | null {
  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = call.getExpression();
    if (expr.getText() === 'defineType') return call;
  }
  return null;
}

function getCallObjectArg(expr: Expression): ObjectLiteralExpression | null {
  if (!expr.asKind(SyntaxKind.CallExpression)) return null;
  const call = expr.asKindOrThrow(SyntaxKind.CallExpression);
  const arg = call.getArguments()[0];
  if (!arg) return null;
  return arg.asKind(SyntaxKind.ObjectLiteralExpression) ?? null;
}

function parseDefineTypeObject(
  obj: ObjectLiteralExpression,
  opts: ParseOptions,
  warnings: Array<{ location: string; reason: string }>,
): ParsedSanitySchema {
  const props = readObjectProperties(obj);
  const name = readStringProperty(props, 'name') ?? 'unknown';
  const title = readStringProperty(props, 'title');
  const type = (readStringProperty(props, 'type') ?? 'object') as 'object' | 'document';
  const groups = readGroupsProperty(props);

  const fieldsArr = props.fields?.asKind(SyntaxKind.ArrayLiteralExpression);
  const fields: ParsedSanityField[] = fieldsArr
    ? parseFieldsArray(fieldsArr, `${name}.fields`, opts, warnings)
    : [];

  return { name, title, type, groups, fields };
}

function readObjectProperties(obj: ObjectLiteralExpression): Record<string, Expression> {
  const out: Record<string, Expression> = {};
  for (const prop of obj.getProperties()) {
    const pa = prop.asKind(SyntaxKind.PropertyAssignment);
    if (!pa) continue;
    out[pa.getName()] = pa.getInitializerOrThrow();
  }
  return out;
}

function readStringProperty(props: Record<string, Expression>, key: string): string | undefined {
  const expr = props[key];
  if (!expr) return undefined;
  const lit = expr.asKind(SyntaxKind.StringLiteral) ?? expr.asKind(SyntaxKind.NoSubstitutionTemplateLiteral);
  return lit?.getLiteralValue();
}

function readBooleanProperty(props: Record<string, Expression>, key: string): boolean | undefined {
  const expr = props[key];
  if (!expr) return undefined;
  if (expr.getKind() === SyntaxKind.TrueKeyword) return true;
  if (expr.getKind() === SyntaxKind.FalseKeyword) return false;
  return undefined;
}

function readNumberProperty(props: Record<string, Expression>, key: string): number | undefined {
  const expr = props[key];
  if (!expr) return undefined;
  const lit = expr.asKind(SyntaxKind.NumericLiteral);
  return lit ? Number(lit.getText()) : undefined;
}

function readLiteralValue(expr: Expression): string | number | boolean | undefined {
  const s = expr.asKind(SyntaxKind.StringLiteral) ?? expr.asKind(SyntaxKind.NoSubstitutionTemplateLiteral);
  if (s) return s.getLiteralValue();
  const n = expr.asKind(SyntaxKind.NumericLiteral);
  if (n) return Number(n.getText());
  if (expr.getKind() === SyntaxKind.TrueKeyword) return true;
  if (expr.getKind() === SyntaxKind.FalseKeyword) return false;
  return undefined;
}

function readGroupsProperty(
  props: Record<string, Expression>,
): ReadonlyArray<{ name: string; title: string; default?: boolean }> | undefined {
  const arr = props['groups']?.asKind(SyntaxKind.ArrayLiteralExpression);
  if (!arr) return undefined;
  return arr.getElements()
    .map((el) => el.asKind(SyntaxKind.ObjectLiteralExpression))
    .filter((el): el is ObjectLiteralExpression => el !== undefined)
    .map((el) => {
      const p = readObjectProperties(el);
      const name = readStringProperty(p, 'name') ?? '';
      const title = readStringProperty(p, 'title') ?? name;
      const def = readBooleanProperty(p, 'default');
      return def !== undefined ? { name, title, default: def } : { name, title };
    });
}

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

function parseFieldsArray(
  arr: import('ts-morph').ArrayLiteralExpression,
  location: string,
  opts: ParseOptions,
  warnings: Array<{ location: string; reason: string }>,
): ParsedSanityField[] {
  const out: ParsedSanityField[] = [];
  for (const el of arr.getElements()) {
    // Spread: `...visibilityFields`
    const spread = el.asKind(SyntaxKind.SpreadElement);
    if (spread) {
      const spreadName = spread.getExpression().getText();
      const known = opts.knownFieldSets?.[spreadName];
      if (known) {
        out.push(...known);
      } else {
        warnings.push({ location, reason: `unresolved spread: ...${spreadName}` });
      }
      continue;
    }

    // Wrapped in defineField(...) — unwrap.
    const inner = unwrapDefineField(el);
    if (!inner) {
      warnings.push({ location, reason: `non-object element: ${el.getKindName()}` });
      continue;
    }

    out.push(parseFieldObject(inner, location, opts, warnings));
  }
  return out;
}

function unwrapDefineField(expr: Expression): ObjectLiteralExpression | null {
  // Pattern A: defineField({...})
  const call = expr.asKind(SyntaxKind.CallExpression);
  if (call && call.getExpression().getText() === 'defineField') {
    const arg = call.getArguments()[0];
    return arg?.asKind(SyntaxKind.ObjectLiteralExpression) ?? null;
  }
  // Pattern B: { ... } directly
  return expr.asKind(SyntaxKind.ObjectLiteralExpression) ?? null;
}

function parseFieldObject(
  obj: ObjectLiteralExpression,
  parentPath: string,
  opts: ParseOptions,
  warnings: Array<{ location: string; reason: string }>,
): ParsedSanityField {
  const props = readObjectProperties(obj);
  const name = readStringProperty(props, 'name') ?? '?';
  const type = (readStringProperty(props, 'type') ?? 'string') as SanityFieldType;
  const fieldPath = `${parentPath}.${name}`;

  const out: ParsedSanityField = { name, type };
  const title = readStringProperty(props, 'title');
  if (title !== undefined) out.title = title;
  const description = readStringProperty(props, 'description');
  if (description !== undefined) out.description = description;
  const group = readStringProperty(props, 'group');
  if (group !== undefined) out.group = group;

  // initialValue can be a literal (most common).
  if (props['initialValue']) {
    const v = readLiteralValue(props['initialValue']);
    if (v !== undefined) out.initialValue = v;
  }

  // options: { list: [...], layout, hotspot, rows, ... }
  const optionsObj = props['options']?.asKind(SyntaxKind.ObjectLiteralExpression);
  if (optionsObj) out.options = parseOptions(optionsObj);

  // validation: Rule => Rule.required().min(5)
  if (props['validation']) {
    out.validation = parseValidation(props['validation'], fieldPath, warnings);
  }

  // hidden: ({parent}) => parent.foo !== 'bar'
  if (props['hidden']) {
    const cond = parseHidden(props['hidden']);
    if (cond) out.hidden = cond;
  }

  // Nested object fields
  const nestedFields = props['fields']?.asKind(SyntaxKind.ArrayLiteralExpression);
  if (nestedFields) {
    out.fields = parseFieldsArray(nestedFields, fieldPath, opts, warnings);
  }

  // Array `of: [...]`
  const ofArr = props['of']?.asKind(SyntaxKind.ArrayLiteralExpression);
  if (ofArr) {
    out.of = parseArrayOf(ofArr, fieldPath, opts, warnings);
  }

  // Reference `to: [{type: 'page'}, ...]`
  const toArr = props['to']?.asKind(SyntaxKind.ArrayLiteralExpression);
  if (toArr) {
    out.to = toArr.getElements()
      .map((el) => el.asKind(SyntaxKind.ObjectLiteralExpression))
      .filter((el): el is ObjectLiteralExpression => el !== undefined)
      .map((el) => readStringProperty(readObjectProperties(el), 'type') ?? '')
      .filter((s) => s.length > 0);
  }

  return out;
}

function parseOptions(obj: ObjectLiteralExpression): ParsedFieldOptions {
  const props = readObjectProperties(obj);
  const opts: ParsedFieldOptions = {};

  const listArr = props['list']?.asKind(SyntaxKind.ArrayLiteralExpression);
  if (listArr) {
    opts.list = listArr.getElements()
      .map((el): { title?: string; value: string | number | boolean } | null => {
        // Element may be `{title, value}` or just a string literal.
        const lit = el.asKind(SyntaxKind.StringLiteral);
        if (lit) return { value: lit.getLiteralValue() };
        const o = el.asKind(SyntaxKind.ObjectLiteralExpression);
        if (!o) return null;
        const p = readObjectProperties(o);
        const value = p['value'] ? readLiteralValue(p['value']) : undefined;
        if (value === undefined) return null;
        const title = readStringProperty(p, 'title');
        return title !== undefined ? { title, value } : { value };
      })
      .filter((x): x is { title?: string; value: string | number | boolean } => x !== null);
  }
  const layout = readStringProperty(props, 'layout');
  if (layout === 'radio' || layout === 'dropdown' || layout === 'tags') opts.layout = layout;
  const direction = readStringProperty(props, 'direction');
  if (direction === 'horizontal' || direction === 'vertical') opts.direction = direction;
  const hotspot = readBooleanProperty(props, 'hotspot');
  if (hotspot !== undefined) opts.hotspot = hotspot;
  const accept = readStringProperty(props, 'accept');
  if (accept !== undefined) opts.accept = accept;
  const collapsible = readBooleanProperty(props, 'collapsible');
  if (collapsible !== undefined) opts.collapsible = collapsible;
  const collapsed = readBooleanProperty(props, 'collapsed');
  if (collapsed !== undefined) opts.collapsed = collapsed;
  const rows = readNumberProperty(props, 'rows');
  if (rows !== undefined) opts.rows = rows;

  return opts;
}

function parseValidation(
  expr: Expression,
  fieldPath: string,
  warnings: Array<{ location: string; reason: string }>,
): ParsedValidation[] {
  // Most common form: Rule => Rule.required().min(N).max(M)
  // We parse the call chain.
  const arrow = expr.asKind(SyntaxKind.ArrowFunction);
  const body = arrow?.getBody();
  if (!body) {
    warnings.push({ location: fieldPath, reason: 'validation: non-arrow form' });
    return [];
  }
  // body is either an expression (arrow without braces) or a block.
  const rootExpr = body.asKind(SyntaxKind.Block)
    ? (() => {
        warnings.push({ location: fieldPath, reason: 'validation: block body — not parsed' });
        return null;
      })()
    : (body as Expression);
  if (!rootExpr) return [];

  const rules: ParsedValidation[] = [];
  walkCallChain(rootExpr, (methodName, args) => {
    if (methodName === 'required') rules.push({ kind: 'required' });
    else if (methodName === 'min' || methodName === 'max') {
      const n = args[0] ? readLiteralValue(args[0]) : undefined;
      if (typeof n === 'number') rules.push({ kind: methodName, value: n });
    } else if (methodName === 'minLength' || methodName === 'maxLength') {
      const n = args[0] ? readLiteralValue(args[0]) : undefined;
      if (typeof n === 'number') rules.push({ kind: methodName, value: n });
    } else if (methodName === 'custom') {
      rules.push({ kind: 'custom', source: args[0]?.getText() });
    }
  });
  return rules;
}

function walkCallChain(expr: Expression, visit: (methodName: string, args: Expression[]) => void): void {
  let cursor: Node | undefined = expr;
  while (cursor) {
    const call: import('ts-morph').CallExpression | undefined = cursor.asKind(SyntaxKind.CallExpression);
    if (!call) break;
    const callee: import('ts-morph').PropertyAccessExpression | undefined = call.getExpression().asKind(SyntaxKind.PropertyAccessExpression);
    if (!callee) break;
    visit(callee.getName(), call.getArguments() as Expression[]);
    cursor = callee.getExpression();
  }
}

function parseHidden(expr: Expression): { parentField: string; expectedValue: string | number | boolean } | null {
  // Pattern: ({parent}) => parent.foo !== 'bar'
  //   or:    ({parent}) => parent?.foo !== 'bar'
  const arrow = expr.asKind(SyntaxKind.ArrowFunction);
  const body = arrow?.getBody();
  const bin = body?.asKind(SyntaxKind.BinaryExpression);
  if (!bin) return null;
  const op = bin.getOperatorToken().getText();
  if (op !== '!==' && op !== '!=' && op !== '===' && op !== '==') return null;
  // Visible when the expression is FALSE — so the equality form means
  // "hidden when equal", "visible when not equal". We capture the value
  // the field should equal to be visible: that's the OPPOSITE side.
  const left = bin.getLeft();
  const right = bin.getRight();
  const propAccess = left.asKind(SyntaxKind.PropertyAccessExpression);
  if (!propAccess) return null;
  const parentField = propAccess.getName();
  const lit = readLiteralValue(right);
  if (lit === undefined) return null;
  // `parent.x !== 'value'` → hidden when not equal → visible WHEN equal
  // → expectedValue = lit. Inverted for === (`parent.x === 'value'`
  // means hidden when equal → visible when NOT equal — we'd need a
  // negation in JSON Schema; for now return null and let caller skip.
  if (op === '!==' || op === '!=') return { parentField, expectedValue: lit };
  return null;
}

function parseArrayOf(
  arr: import('ts-morph').ArrayLiteralExpression,
  parentPath: string,
  opts: ParseOptions,
  warnings: Array<{ location: string; reason: string }>,
): ParsedArrayMember[] {
  const out: ParsedArrayMember[] = [];
  for (const el of arr.getElements()) {
    // Sanity content may wrap members in `defineArrayMember({...})` —
    // unwrap the same way we do for defineField.
    let obj: ObjectLiteralExpression | undefined = el.asKind(SyntaxKind.ObjectLiteralExpression);
    if (!obj) {
      const call = el.asKind(SyntaxKind.CallExpression);
      if (call && call.getExpression().getText() === 'defineArrayMember') {
        const arg = call.getArguments()[0];
        obj = arg?.asKind(SyntaxKind.ObjectLiteralExpression);
      }
    }
    if (!obj) continue;
    const props = readObjectProperties(obj);
    const type = readStringProperty(props, 'type') ?? '';
    const member: ParsedArrayMember = { type };
    const toArr = props['to']?.asKind(SyntaxKind.ArrayLiteralExpression);
    if (toArr) {
      member.to = toArr.getElements()
        .map((e) => e.asKind(SyntaxKind.ObjectLiteralExpression))
        .filter((e): e is ObjectLiteralExpression => e !== undefined)
        .map((e) => readStringProperty(readObjectProperties(e), 'type') ?? '')
        .filter((s) => s.length > 0);
    }
    const nestedFields = props['fields']?.asKind(SyntaxKind.ArrayLiteralExpression);
    if (nestedFields) {
      member.fields = parseFieldsArray(nestedFields, `${parentPath}[].${type}`, opts, warnings);
    }
    out.push(member);
  }
  return out;
}
