import { parse, type AnyNode } from 'acorn';
import { isAbsolute, resolve } from 'node:path';

const DYNAMIC = '\0';

/** Recorded patch arguments identify attempted file references, not successful writes. */
export function addCodexToolPaths(row: unknown, out: Set<string>, cwd?: string | null): void {
  if (!row || typeof row !== 'object') return;
  const record = row as { type?: unknown; payload?: unknown };
  if (record.type !== 'response_item' || !record.payload || typeof record.payload !== 'object') return;
  const tool = record.payload as { type?: unknown; name?: unknown; input?: unknown; arguments?: unknown };
  if (tool.type !== 'custom_tool_call' && tool.type !== 'function_call') return;
  if (typeof tool.name !== 'string') return;
  const name = tool.name.split('.').at(-1);
  if (name === 'apply_patch') {
    if (tool.type === 'custom_tool_call' && typeof tool.input === 'string') addPatchPaths(tool.input, out, cwd);
    if (tool.type === 'function_call' && typeof tool.arguments === 'string') {
      try {
        const args: unknown = JSON.parse(tool.arguments);
        if (args && typeof args === 'object') {
          const patch = args as { input?: unknown; patch?: unknown };
          if (typeof patch.input === 'string') addPatchPaths(patch.input, out, cwd);
          if (typeof patch.patch === 'string') addPatchPaths(patch.patch, out, cwd);
        }
      } catch { /* Malformed producer arguments provide no path evidence. */ }
    }
    return;
  }
  if (name !== 'exec' || typeof tool.input !== 'string') return;
  let program: AnyNode;
  try {
    program = parse(tool.input, { ecmaVersion: 'latest', sourceType: 'module', allowReturnOutsideFunction: true });
  } catch { return; }
  const stack: AnyNode[] = [program];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression') {
      const callee = node.callee;
      if (!callee.computed && callee.object.type === 'Identifier' && callee.object.name === 'tools'
        && callee.property.type === 'Identifier' && callee.property.name === 'apply_patch' && node.arguments.length === 1) {
        addPatchPaths(staticFragments(node.arguments[0]!), out, cwd);
      }
    }
    for (const value of Object.values(node)) {
      for (const child of Array.isArray(value) ? value : [value]) {
        if (child && typeof child === 'object' && typeof child.type === 'string') stack.push(child as AnyNode);
      }
    }
  }
}

function staticFragments(node: AnyNode): string {
  const parts: string[] = [];
  const stack = [node];
  while (stack.length) {
    const part = stack.pop()!;
    if (part.type === 'Literal' && typeof part.value === 'string') parts.push(part.value);
    else if (part.type === 'TemplateLiteral' && part.expressions.length === 0) parts.push(part.quasis[0]?.value.cooked ?? DYNAMIC);
    else if (part.type === 'BinaryExpression' && part.operator === '+') stack.push(part.right, part.left);
    // shortcut: identifiers and computed expressions remain unknown; add lexical binding resolution if producer evidence needs it.
    else parts.push(DYNAMIC);
  }
  return parts.join('');
}

function addPatchPaths(patch: string, out: Set<string>, cwd?: string | null): void {
  const lines = patch.trim().split(/\r?\n/);
  if (lines[0] !== '*** Begin Patch' || lines.at(-1) !== '*** End Patch') return;
  for (const line of lines.slice(1, -1)) {
    const match = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/.exec(line);
    if (!match) continue;
    const path = match[1]!.trim();
    if (!path || path.includes(DYNAMIC)) continue;
    if (isAbsolute(path)) out.add(resolve(path));
    else if (cwd && isAbsolute(cwd)) out.add(resolve(cwd, path));
  }
}
