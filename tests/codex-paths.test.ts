import { describe, expect, test } from 'bun:test';
import { addCodexToolPaths } from '../src/core/codex-paths.ts';

const patch = '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** End Patch';
const exec = (input: string) => ({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input } });
const paths = (row: unknown, cwd: string | null = '/repo') => {
  const out = new Set<string>();
  addCodexToolPaths(row, out, cwd);
  return [...out].sort();
};

describe('Codex producer patch paths', () => {
  test('extracts the actual exec producer shape, including escaped literals', () => {
    const escaped = patch.replace('src/a.ts', 'src/quo"te\\file.ts');
    expect(paths(exec(`text(await tools.apply_patch(${JSON.stringify(escaped)}));`))).toEqual(['/repo/src/quo"te\\file.ts']);
  });

  test('accepts direct freeform and JSON argument calls with exact tool basenames', () => {
    expect(paths({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'functions.apply_patch', input: patch } })).toEqual(['/repo/src/a.ts']);
    for (const key of ['input', 'patch']) {
      expect(paths({ type: 'response_item', payload: { type: 'function_call', name: 'apply_patch', arguments: JSON.stringify({ [key]: patch }) } })).toEqual(['/repo/src/a.ts']);
    }
    expect(paths({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch_extra', input: patch } })).toEqual([]);
  });

  test('extracts add, update, delete and both sides of a move without hunk mentions', () => {
    const all = '*** Begin Patch\r\n*** Add File: added.ts\r\n+*** Update File: fake.ts\r\n*** Update File: old.ts\r\n*** Move to: moved.ts\r\n@@\r\n-*** Delete File: fake.ts\r\n *** Add File: fake.ts\r\n*** Delete File: /outside/deleted.ts\r\n*** End Patch\r\n';
    expect(paths(exec(`await tools.apply_patch(${JSON.stringify(all)})`))).toEqual(['/outside/deleted.ts', '/repo/added.ts', '/repo/moved.ts', '/repo/old.ts']);
  });

  test('uses supplied current cwd and never guesses absent or relative cwd', () => {
    const row = exec(`await tools.apply_patch(${JSON.stringify(patch)})`);
    expect(paths(row, '/repo/apps/web')).toEqual(['/repo/apps/web/src/a.ts']);
    expect(paths(row, null)).toEqual([]);
    expect(paths(row, 'relative')).toEqual([]);
    expect(paths(exec(`tools.apply_patch(${JSON.stringify(patch.replace('src/a.ts', '/repo/src/a.ts'))})`), null)).toEqual(['/repo/src/a.ts']);
  });

  test('supports static templates and concatenation around dynamic patch bodies', () => {
    expect(paths(exec('await tools.apply_patch(`' + patch + '`)'))).toEqual(['/repo/src/a.ts']);
    const before = '*** Begin Patch\n*** Add File: first.ts\n+';
    const after = '\n*** Update File: second.ts\n@@\n-old\n+new\n*** End Patch';
    expect(paths(exec(`tools.apply_patch(${JSON.stringify(before)} + JSON.stringify(config) + ${JSON.stringify(after)})`))).toEqual(['/repo/first.ts', '/repo/second.ts']);
  });

  test('does not guess partially dynamic paths or identifier bindings', () => {
    expect(paths(exec('tools.apply_patch("*** Begin Patch\\n*** Update File: " + filename + "\\n@@\\n-a\\n+b\\n*** End Patch")'))).toEqual([]);
    expect(paths(exec('tools.apply_patch("*** Begin Patch\\n*** Update File: src/" + filename + ".ts\\n@@\\n-a\\n+b\\n*** End Patch")'))).toEqual([]);
    expect(paths(exec(`const input = ${JSON.stringify(patch)}; tools.apply_patch(input)`))).toEqual([]);
    expect(paths(exec('tools.apply_patch(`*** Begin Patch\n*** Update File: ${filename}\n*** End Patch`)'))).toEqual([]);
  });

  test('excludes user messages, tool outputs, comments, string mentions and unrelated calls', () => {
    const source = `tools.apply_patch(${JSON.stringify(patch)})`;
    expect(paths({ type: 'event_msg', payload: { type: 'user_message', message: source } })).toEqual([]);
    expect(paths({ type: 'response_item', payload: { type: 'custom_tool_call_output', output: source } })).toEqual([]);
    expect(paths(exec(`// ${source}\n/* ${source} */\ntext(${JSON.stringify(source)}); other.apply_patch(${JSON.stringify(patch)}); apply_patch(${JSON.stringify(patch)})`))).toEqual([]);
    expect(paths({ type: 'user', payload: { type: 'custom_tool_call', name: 'exec', input: source } })).toEqual([]);
  });

  test('ignores malformed JavaScript, JSON arguments and patch envelopes', () => {
    expect(paths(exec(`tools.apply_patch(${JSON.stringify(patch)}`))).toEqual([]);
    expect(paths({ type: 'response_item', payload: { type: 'function_call', name: 'apply_patch', arguments: '{bad' } })).toEqual([]);
    for (const input of [patch.replace('*** Begin Patch\n', ''), patch.replace('\n*** End Patch', ''), patch + '\nextra']) {
      expect(paths(exec(`tools.apply_patch(${JSON.stringify(input)})`))).toEqual([]);
    }
    expect(paths(null)).toEqual([]);
    expect(paths({ type: 'response_item', payload: [] })).toEqual([]);
  });
});
