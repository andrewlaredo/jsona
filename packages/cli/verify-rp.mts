// End-to-end verification for jsona MCP Resources + Prompts + roots cache.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  CreateMessageRequestSchema,
  ListRootsRequestSchema,
  type CreateMessageResult,
} from '@modelcontextprotocol/sdk/types.js';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('./src/index.ts', import.meta.url));

async function makeClient() {
  const transport = new StdioClientTransport({ command: 'npx', args: ['tsx', CLI, 'mcp'] });
  const client = new Client(
    { name: 'verify-rp', version: '1.0.0' },
    { capabilities: { sampling: {}, roots: { listChanged: false } } },
  );
  client.setRequestHandler(CreateMessageRequestSchema, async (req) => {
    const last = req.params.messages[req.params.messages.length - 1];
    const text = (last.content as { text?: string }).text ?? '';
    const reply: CreateMessageResult = {
      role: 'assistant',
      model: 'mock-client-llm',
      stopReason: 'endTurn',
      content: { type: 'text', text: `[mock] ${text.slice(0, 60)}` },
    };
    return reply;
  });
  client.setRequestHandler(ListRootsRequestSchema, async () => ({
    roots: [
      { uri: 'file:///projects/jsona', name: 'jsona repo' },
      { uri: 'file:///Users/me/docs', name: 'docs' },
    ],
  }));
  await client.connect(transport);
  return client;
}

async function run() {
  const client = await makeClient();

  // ---- Resources ----
  const resources = await client.listResources();
  const uris = resources.resources.map((r) => r.uri);
  console.log('RESOURCES:', uris.join(', '));
  if (!uris.includes('jsona://help')) throw new Error('jsona://help missing');

  const templates = await client.listResourceTemplates();
  const tmplUris = templates.resourceTemplates.map((t) => t.uriTemplate);
  console.log('TEMPLATES:', tmplUris.join(', '));
  if (!tmplUris.includes('jsona://samples/{format}')) throw new Error('samples template missing');

  const help = await client.readResource({ uri: 'jsona://help' });
  const helpText = (help.contents[0] as any).text;
  console.log('HELP bytes:', helpText.length, '| has Tools section:', helpText.includes('## Tools'));

  const sample = await client.readResource({ uri: 'jsona://samples/json' });
  const sampleText = (sample.contents[0] as any).text;
  console.log('SAMPLE(json) valid JSON:', (() => { try { JSON.parse(sampleText); return true; } catch { return false; } })());

  try {
    await client.readResource({ uri: 'jsona://samples/xyz' });
    throw new Error('expected error for bad format');
  } catch (e) {
    console.log('BAD format rejected:', (e as Error).message.includes('unknown format'));
  }

  // ---- Prompts ----
  const prompts = await client.listPrompts();
  const pnames = prompts.prompts.map((p) => p.name);
  console.log('PROMPTS:', pnames.join(', '));
  if (!pnames.includes('jsona_explain') || !pnames.includes('jsona_validate'))
    throw new Error('prompts missing');

  const ex = await client.getPrompt({ name: 'jsona_explain', arguments: { format: 'json', question: 'what is this?' } });
  console.log('EXPLAIN prompt msgs:', (ex.messages as any[]).length, '| mentions schema:', (ex.messages[0].content as any).text.includes('jsona_schema'));

  const va = await client.getPrompt({ name: 'jsona_validate', arguments: { source: '{"a":1}', format: 'json' } });
  console.log('VALIDATE prompt mentions validate:', (va.messages[0].content as any).text.toLowerCase().includes('validate'));

  // ---- roots cache ----
  const r1 = await client.callTool({ name: 'jsona_roots', arguments: { refresh: false } });
  const r1j = JSON.parse((r1.content as any)[0].text);
  console.log('ROOTS count:', r1j.count, 'cached:', r1j.cached);
  const r2 = await client.callTool({ name: 'jsona_roots', arguments: { refresh: false } });
  const r2j = JSON.parse((r2.content as any)[0].text);
  console.log('ROOTS 2nd cached (should be true):', r2j.cached);
  const r3 = await client.callTool({ name: 'jsona_roots', arguments: { refresh: true } });
  const r3j = JSON.parse((r3.content as any)[0].text);
  console.log('ROOTS refresh cached (should be false):', r3j.cached);

  await client.close();
  console.log('\nVERIFY OK');
}

run().catch((e) => {
  console.error('VERIFY FAILED:', e);
  process.exit(1);
});
