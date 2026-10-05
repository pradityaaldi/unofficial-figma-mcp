// Regression test: several Figma files connected at the same time.
// Fake plugins stand in for two files ("Alpha", "Beta"); a second MCP process
// relays through the first. No Figma instance required.
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

const PORT = 3201;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;

function check(label, ok, extra = '') {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (ok ? '' : '  ' + extra));
  if (!ok) failures++;
}

function startClient(label) {
  const child = spawn('node', ['mcp/server.js'], {
    env: { ...process.env, BRIDGE_PORT: String(PORT) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(`  [${label}] ${d}`));
  let buffer = '';
  let id = 0;
  const replies = new Map();
  child.stdout.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      const m = JSON.parse(line);
      const r = replies.get(m.id);
      if (r) { replies.delete(m.id); r(m); }
    }
  });
  const rpc = (method, params) => new Promise((resolve) => {
    const requestId = ++id;
    replies.set(requestId, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
  });
  const tool = async (name, args = {}) => {
    const r = await rpc('tools/call', { name, arguments: args });
    return { text: r.result.content[0].text, isError: !!r.result.isError };
  };
  return { child, rpc, tool };
}

async function initialize(client) {
  await client.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'multi-file-test', version: '1' } });
  client.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
}

async function fakePlugin(file) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.send(JSON.stringify({ type: 'hello', role: 'plugin', file }));
  ws.closeCode = null;
  ws.on('close', (code) => { ws.closeCode = code; });
  ws.on('message', (raw) => {
    const { id, command, params } = JSON.parse(raw.toString());
    if (command === 'ping') ws.send(JSON.stringify({ id, ok: true, data: { file, page: 'Page 1' } }));
    else if (command === 'exec') ws.send(JSON.stringify({ id, ok: true, data: { from: file, code: params.code } }));
  });
  await sleep(150);
  return ws;
}

const primary = startClient('primary');
await initialize(primary);
await sleep(300);

const alpha = await fakePlugin('Alpha');
const beta = await fakePlugin('Beta');

// 1. Two files stay connected side by side; neither evicts the other.
check('Alpha is not evicted when Beta connects', alpha.readyState === WebSocket.OPEN && alpha.closeCode === null, `closeCode=${alpha.closeCode}`);
const st = await primary.tool('figma_status');
check('figma_status lists both files', st.text.includes('Alpha') && st.text.includes('Beta'), st.text);

// 2. Safety: with several files and no target, refuse instead of guessing.
const amb = await primary.tool('figma_exec', { code: 'return 1' });
check('no target + several files is refused', amb.isError && amb.text.includes('Several'), amb.text);

// 3. Explicit targeting.
const toA = await primary.tool('figma_exec', { code: 'a', file: 'Alpha' });
const toB = await primary.tool('figma_exec', { code: 'b', file: 'beta' }); // case-insensitive
check('file:"Alpha" reaches Alpha', toA.text.includes('"from":"Alpha"'), toA.text);
check('file:"beta" reaches Beta (case-insensitive)', toB.text.includes('"from":"Beta"'), toB.text);
const nope = await primary.tool('figma_exec', { code: 'x', file: 'Gamma' });
check('unknown file gives a clear error', nope.isError && nope.text.includes('not connected') && nope.text.includes('Alpha'), nope.text);

// 4. Default file.
const use = await primary.tool('figma_use_file', { file: 'Beta' });
check('figma_use_file accepts a connected file', !use.isError && use.text.includes('Beta'), use.text);
const dflt = await primary.tool('figma_exec', { code: 'd' });
check('later calls follow the default file', dflt.text.includes('"from":"Beta"'), dflt.text);
const override = await primary.tool('figma_exec', { code: 'o', file: 'Alpha' });
check('an explicit file overrides the default', override.text.includes('"from":"Alpha"'), override.text);
const badUse = await primary.tool('figma_use_file', { file: 'Gamma' });
check('figma_use_file rejects an unknown file', badUse.isError, badUse.text);

// 5. A relay process (second MCP session) shares the bridge and has its own default.
const secondary = startClient('secondary');
await initialize(secondary);
await sleep(500);
const rAmb = await secondary.tool('figma_exec', { code: 'r' });
check("primary's default does not leak into another session", rAmb.isError && rAmb.text.includes('Several'), rAmb.text);
const rA = await secondary.tool('figma_exec', { code: 'r', file: 'Alpha' });
check('relay can target Alpha explicitly', rA.text.includes('"from":"Alpha"'), rA.text);
await secondary.tool('figma_use_file', { file: 'Beta' });
const rB = await secondary.tool('figma_exec', { code: 'r' });
check('relay keeps its own default file', rB.text.includes('"from":"Beta"'), rB.text);
const rStatus = await secondary.tool('figma_status');
check('relay sees both files in figma_status', rStatus.text.includes('Alpha') && rStatus.text.includes('Beta'), rStatus.text);

// 6. A second window of the SAME file replaces the first (code 1012), not the other file.
const alpha2 = await fakePlugin('Alpha');
await sleep(150);
check('same-file reconnect closes the old Alpha socket with 1012', alpha.closeCode === 1012, `closeCode=${alpha.closeCode}`);
check('Beta is unaffected by the Alpha takeover', beta.readyState === WebSocket.OPEN);
const toA2 = await primary.tool('figma_exec', { code: 'a2', file: 'Alpha' });
check('Alpha now routes to the new window', toA2.text.includes('"from":"Alpha"'), toA2.text);

// 7. A disconnect only affects its own file.
beta.close();
await sleep(200);
const gone = await primary.tool('figma_exec', { code: 'g', file: 'Beta' });
check('closed file reports not connected', gone.isError && gone.text.includes('not connected'), gone.text);
const still = await primary.tool('figma_exec', { code: 's' });
check('a default file that disconnected is refused, never silently re-routed', still.isError && still.text.includes('Beta'), still.text);
const reset = await primary.tool('figma_use_file', { file: 'Alpha' });
const ok2 = await primary.tool('figma_exec', { code: 'k' });
check('choosing a connected file again restores routing', !reset.isError && ok2.text.includes('"from":"Alpha"'), ok2.text);

secondary.child.kill();
alpha2.close();
primary.child.kill();
console.log(failures === 0 ? '\nAll multi-file checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
