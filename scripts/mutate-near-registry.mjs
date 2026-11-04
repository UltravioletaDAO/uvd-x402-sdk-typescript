/** Explicit, reproducible guard mutations. Run from a clean committed tree, under the CI Node version.
 * Each test process has a 120s timeout; timeout counts as killed. Every edit is restored with git checkout.
 * Usage: node scripts/mutate-near-registry.mjs [M01 M02 ...]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const file = 'src/providers/near/registry.ts';
function git(...args) {
  const p = spawnSync('git', args, { encoding: 'utf8', timeout: 30000 });
  if (p.status !== 0) throw new Error(p.stderr || 'git failed');
  return p.stdout;
}
if (git('status', '--porcelain').trim()) throw new Error('Commit changes before mutation testing');
const source = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const changes = [];
function add(name, before, after) {
  if (source.split(before).length !== 2) throw new Error(`Mutation must match once: ${name}`);
  changes.push({ id: `M${String(changes.length + 1).padStart(2, '0')}`, name, before, after });
}
add('URI maximum', 'value.length <= 512', 'value.length <= 513');
add('URI scheme first character', '^[A-Za-z][A-Za-z0-9+.-]*:', '^[A-Za-z0-9][A-Za-z0-9+.-]*:');
add('URI scheme alphabet', '[A-Za-z0-9+.-]*:', '[A-Za-z0-9+._-]*:');
add('URI nonempty suffix', '[\\x21-\\x7e]+$', '[\\x21-\\x7e]*$');
add('URI printable bytes', '[\\x21-\\x7e]+$', '[\\s\\S]+$');
add('metadata minimum', 'value.length > 0', 'value.length >= 0');
add('metadata byte maximum', 'encode(value).length <= 1024', 'encode(value).length <= 1025');
add('metadata ASCII controls', '!/[\\x00-\\x1f\\x7f]/u.test(value)', 'true');
add('metadata Unicode scalar', '!/[\\ud800-\\udfff]/u.test(value)', 'true');
add('tag minimum', '[A-Za-z0-9._:/-]{1,64}', '[A-Za-z0-9._:/-]{0,64}');
add('tag maximum', '[A-Za-z0-9._:/-]{1,64}', '[A-Za-z0-9._:/-]{1,65}');
add('tag alphabet', '[A-Za-z0-9._:/-]{1,64}', '[\\x21-\\x7e]{1,64}');
add('payment minimum', 'fullMatch(/^[\\x21-\\x7e]{1,64}$/, value)', 'fullMatch(/^[\\x21-\\x7e]{0,64}$/, value)');
add('payment maximum', 'fullMatch(/^[\\x21-\\x7e]{1,64}$/, value)', 'fullMatch(/^[\\x21-\\x7e]{1,65}$/, value)');
add('payment alphabet', 'fullMatch(/^[\\x21-\\x7e]{1,64}$/, value)', 'fullMatch(/^[\\s\\S]{1,64}$/, value)');
add('hash exact size', '[0-9a-f]{64}', '[0-9a-f]{63,65}');
add('hash alphabet/case', '[0-9a-f]{64}', '[0-9A-Za-z]{64}');
add('score integer', 'Number.isInteger(value)', 'Number.isFinite(value)');
add('score minimum', 'value >= 0 && value <= 100', 'value >= -1 && value <= 100');
add('score maximum', 'value >= 0 && value <= 100', 'value >= 0 && value <= 101');
add('network allowlist', "value !== 'near:mainnet' && value !== 'near:testnet'", "value !== 'near:mainnet' && value !== 'near:testnet' && value !== 'near'");
add('receiver allowlist', '!NEAR_REGISTRY_CONTRACTS[o.network].includes(id)', 'false');
add('escrow allowlist', 'NEAR_REGISTRY_ESCROWS[net].includes(value)', 'true');
add('signer account', "account(o.signerId, 'signerId');", '');
add('extra args', 'Object.keys(input).some((key) => !allowed.includes(key))', 'false');
add('agent URI call', 'requireRule(validUri(input.agent_uri),', 'requireRule(true,');
add('metadata call', 'requireRule(validMetadata(input.metadata),', 'requireRule(true,');
add('payment ID call', 'requireRule(validPaymentId(input.payment_id), RegistryErrorCode.E11);\n    args', 'requireRule(true, RegistryErrorCode.E11);\n    args');
add('score call', 'requireRule(validScore(input.score),', 'requireRule(true,');
add('tag1 call', "for (const field of ['tag1', 'tag2'] as const)", "for (const field of ['tag2'] as const)");
add('tag2 call', "for (const field of ['tag1', 'tag2'] as const)", "for (const field of ['tag1'] as const)");
add('feedback URI call', 'requireRule(validUri(input.feedback_uri),', 'requireRule(true,');
add('feedback hash call', 'requireRule(validHash(input.feedback_hash),', 'requireRule(true,');
add('exact revoke deposit', 'if (deposit !== 1n)', 'if (false)');
add('update positive deposit', 'requireRule(deposit > 0n,', 'requireRule(true,');
add('minimum storage/feedback deposit', 'deposit >= BigInt(minimum)', 'deposit >= BigInt(minimum) - 1n');
add('minimum feedback gas', 'BigInt(MIN_GIVE_FEEDBACK_GAS) : 1n', 'BigInt(MIN_GIVE_FEEDBACK_GAS) - 1n : 1n');
add('minimum other gas', 'BigInt(MIN_GIVE_FEEDBACK_GAS) : 1n', 'BigInt(MIN_GIVE_FEEDBACK_GAS) : 0n');
add('maximum gas', 'gas <= 300_000_000_000_000n', 'gas <= 300_000_000_000_001n');
add('signing receiver', "if (!net) throw new Error('receiverId: unregistered registry');", "if (!net) return 'unregistered';");
add('one action', '!Array.isArray(actions) || actions.length !== 1', '!Array.isArray(actions)');
add('action type', "action.type !== 'FunctionCall'", 'false');
add('method allowlist', "!['register', 'update', 'give_feedback', 'revoke_feedback'].includes(p.methodName)", 'false');
add('monetary descriptor fields', "typeof p.gas !== 'string' || typeof p.deposit !== 'string'", 'false');
add('args object', '!object(p.args)', 'false');
add('positive nonce', 'if (n === 0n)', 'if (false)');
add('block hash length', 'if (hash.length !== 32)', 'if (false)');
add('public key length', 'if (pk.length !== 32)', 'if (false)');
add('signature check', '!(signature instanceof Uint8Array) || signature.length !== 64 || !ed25519.verify(signature, digest, pk)', 'false');
add('RPC HTTP status', '!response.ok', 'false');
add('RPC envelope', "!object(data) || data.error || !Object.hasOwn(data, 'result')", 'false');
add('view shape', 'if (!check(value))', 'if (false)');
add('decimal integer strings', "if (typeof v !== 'string') return false;", '');
add('u32 number type', "typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xffffffff", "Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 0xffffffff");
add('u32 range', 'v <= 0xffffffff', 'v <= 0x100000000');
add('operator maximum', 'encode(v).length <= 64', 'encode(v).length <= 65');
add('operator Unicode scalar', '!/[\\ud800-\\udfff]/u.test(v)', 'true');
add('nullable shape', 'v === null || check(v)', 'v == null || check(v)');
add('required fields', 'Object.hasOwn(v, k) && check(v[k])', 'true');
add('optional fields', '!Object.hasOwn(v, k) || check(v[k])', 'true');
add('average maximum', 'v <= 10000', 'v <= 10001');
add('pagination u32', 'if (!u32(v))', 'if (false)');
add('feedback id input', 'if (!u32(feedbackId))', 'if (false)');
add('operator input', "if (typeof operatorId !== 'string')", 'if (false)');
add('global summary shape', "&& !Object.hasOwn(v, 'operator_id')", '');
add('operator summary shape', "&& Object.hasOwn(v, 'operator_id')", '');
add('event standard', "v.standard !== 'arras-registry'", 'false');
add('event version', "v.version !== '1.0.0'", 'false');
add('event fields', 'if (!v.data.every(eventChecks[v.event as keyof RegistryEventData]))', 'if (false)');
add('outcome rejection allowlist', 'if (rejectionCodes.includes(code))', 'if (true)');
add('outcome rejection ambiguity', 'if (codes.size === 1)', 'if (codes.size >= 1)');
add('summary input shape', 'if (!feedbackCheck(f))', 'if (false)');
add('summary escrow filter', 'f.escrow !== escrow || f.operator_id !== operatorId', 'f.operator_id !== operatorId');
add('summary operator filter', 'f.escrow !== escrow || f.operator_id !== operatorId', 'f.escrow !== escrow');
add('summary revoked filter', 'if (f.revoked)', 'if (false)');
add('safe display scheme', '/^(https|ipfs|ar):/i.test(uri)', 'true');

add('call_function response', "!object(response) || !Array.isArray(response.result) ||\n      !response.result.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)", 'false');
add('byte minimum', 'v >= 0 && v <= 255', 'v >= -1 && v <= 255');
add('byte maximum', 'v >= 0 && v <= 255', 'v >= 0 && v <= 256');
add('byte integer', 'Number.isInteger(v) && v >= 0 && v <= 255', 'Number.isFinite(v) && v >= 0 && v <= 255');
add('view array all rows', 'Array.isArray(v) && v.every(check)', 'Array.isArray(v) && v.some(check)');
add('event all rows', 'v.data.every(eventChecks[v.event as keyof RegistryEventData])', 'v.data.some(eventChecks[v.event as keyof RegistryEventData])');
add('event array input', 'if (!Array.isArray(logs)) return result;', '');
add('event prefix', "!log.startsWith('EVENT_JSON:')", 'false');
add('event name allowlist', '!Object.hasOwn(eventChecks, v.event)', 'false');
add('event array data', '!Array.isArray(v.data)', 'false');
add('base64 alphabet', "if (!fullMatch(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/, value))", 'if (false)');
add('view account argument', "account(accountId, 'account_id');", '');
add('view rater account', "account(input.rater, 'rater');", '');
add('boolean field', "const boolean: Check = (v) => typeof v === 'boolean';", 'const boolean: Check = () => true;');
add('role field', "v === 'payer' || v === 'receiver'", 'true');

const requested = process.argv.slice(2);
const selected = changes.filter((m) => !requested.length || requested.includes(m.id));
const env = { ...process.env, HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost', AWS_SHARED_CREDENTIALS_FILE: process.platform === 'win32' ? 'NUL' : '/dev/null' };
delete env.AWS_PROFILE;
function test() { return spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'src/providers/near/registry.test.ts'], { encoding: 'utf8', timeout: 120000, env }); }
const baseline = test();
if (baseline.status !== 0) throw new Error('Unmutated registry tests must pass: ' + baseline.stdout + baseline.stderr);
const failures = [];
for (const m of selected) {
  let result;
  try { writeFileSync(file, source.replace(m.before, m.after)); result = test(); }
  finally { git('checkout', '--', file); }
  const output = (result.stdout || '') + (result.stderr || '');
  const timeout = result.error?.code === 'ETIMEDOUT';
  const invalid = /Transform failed|Failed Suites/.test(output);
  const killed = timeout || (result.status !== 0 && !invalid);
  console.log(`${m.id} | ${m.name} | ${timeout ? 'KILLED (timeout 120s)' : killed ? 'KILLED' : invalid ? 'INVALID' : 'SURVIVED'}`);
  if (!killed) { failures.push(m.id); console.log(output.slice(-2500)); }
}
if (git('status', '--porcelain').trim()) throw new Error('Mutation restoration left changes');
console.log(`${selected.length - failures.length}/${selected.length} killed; failures: ${failures.join(', ') || 'none'}`);
process.exitCode = failures.length ? 1 : 0;
