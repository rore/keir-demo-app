import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CompilerError, createCompiler } from '../src/compiler.mjs';
import { loadHost, TASK_HOOK } from '../src/extension-catalog.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const model = readFileSync(join(root, 'extensions/task-read/dcm.json'));
const source = readFileSync(join(root, 'extensions/task-read/maya.yaml'));
const expected = readFileSync(join(root, 'extensions/task-read/maya.json'));
const vendor = join(root, 'vendor');
const jarName = 'keir-compiler-java-0.1.0-SNAPSHOT-cli.jar';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const isError = (code, status) => error => error instanceof CompilerError && error.code === code && error.status === status;
const unavailable = isError('COMPILER_UNAVAILABLE', 503);
const limit = isError('COMPILER_LIMIT', 413);
const failed = isError('COMPILER_FAILED', 500);
const okScript = "process.stdout.end(Buffer.from('raw artifact bytes'));";

async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'keir-compiler-test-'));
  t.after(async () => {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + '/'.replace('/', process.platform === 'win32' ? '\\' : '/')));
    await rm(directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 25 });
  });
  return directory;
}

function fixture(t, script = okScript, { holdClose = false, ignoreTerm = false } = {}) {
  const calls = [];
  let started, exited;
  const onStart = new Promise(resolve => { started = resolve; });
  const onHeldClose = new Promise(resolve => { exited = resolve; });
  const launch = (java, args, options) => {
    const selected = Array.isArray(script) ? script[Math.min(calls.length, script.length - 1)] : script;
    const child = spawn(process.execPath, ['-e', selected], options);
    const call = { child, java, args, options, signals: [], release: () => {} };
    calls.push(call);
    const kill = child.kill.bind(child);
    child.kill = signal => {
      call.signals.push(signal);
      return ignoreTerm && signal === 'SIGTERM' ? true : kill(signal);
    };
    if (holdClose && calls.length === 1) {
      const emit = child.emit.bind(child);
      child.emit = (name, ...values) => {
        if (name === 'close') { call.release = () => emit(name, ...values); exited(); return true; }
        return emit(name, ...values);
      };
    }
    queueMicrotask(started);
    return child;
  };
  t.after(() => { for (const call of calls) { if (call.child.exitCode === null && call.child.signalCode === null) call.child.kill('SIGKILL'); call.release(); } });
  return { calls, launch, onStart, onHeldClose };
}

async function cleaned(call) {
  await assert.rejects(access(call.options.cwd), { code: 'ENOENT' });
  assert.throws(() => process.kill(call.child.pid, 0), { code: 'ESRCH' });
}

test('distribution is the pinned independent compiler and notice metadata resolves', async () => {
  const info = JSON.parse(await readFile(join(vendor, 'compiler-provenance.json')));
  assert.equal(sha(await readFile(join(vendor, jarName))), info.artifact.sha256.slice(7));
  assert.equal(info.artifact.sha256, 'sha256:631a681210b6e57126f02a916ce5d86ea1797fb1833819799be65a5bdf172d9f');
  assert.equal(info.artifact.bytes, 8_815_071);
  assert.equal(info.profile, 'keir-effect/4');
  assert.deepEqual(info.profiles, ['keir-read/2', 'keir-effect/3', 'keir-effect/4']);
  const notices = await readFile(join(vendor, info.dependencies.metadata), 'utf8');
  assert.equal(info.dependencies.count, 19);
  assert.equal(info.dependencies.preserved_original_notice_count, 5);
  assert.equal((notices.match(/===== END ORIGINAL TEXT =====/g) ?? []).length, 5);
  assert.match(notices, /BSD/);
  assert.match(notices, /Apache/);
});

test('safe direct argv, immutable byte snapshots and minimal JVM environment', async t => {
  const f = fixture(t, "if (process.env.NODE_V8_COVERAGE || process.env.COMPILER_TEST_CREDENTIAL) throw Error('unexpected environment'); " + okScript);
  const bytes = Buffer.from('submitted bytes');
  const hostModel = Buffer.from(model);
  const prior = process.env.COMPILER_TEST_CREDENTIAL;
  process.env.COMPILER_TEST_CREDENTIAL = 'secret';
  t.after(() => { if (prior === undefined) delete process.env.COMPILER_TEST_CREDENTIAL; else process.env.COMPILER_TEST_CREDENTIAL = prior; });
  const compiler = createCompiler({ modelBytes: hostModel, javaExecutable: 'operator path with spaces;&' }, { launch: f.launch });
  hostModel.fill(0);
  const pending = compiler.compile(bytes);
  bytes.fill(0);
  await f.onStart;
  const call = f.calls[0];
  assert.equal(call.java, 'operator path with spaces;&');
  assert.equal(call.options.shell, false);
  assert.equal(call.options.windowsHide, true);
  assert.equal(call.args[0], '-Xmx256m');
  assert.equal(call.args[1], '-XX:-UsePerfData');
  assert.equal(call.args.at(-1), '--profile=keir-read/2');
  assert.equal(sha(await readFile(call.args[5])), '631a681210b6e57126f02a916ce5d86ea1797fb1833819799be65a5bdf172d9f');
  assert.deepEqual(await readFile(call.args[6]), Buffer.from('submitted bytes'));
  assert.deepEqual(await readFile(call.args[7]), model);
  assert.deepEqual(Object.keys(call.options.env).filter(key => call.options.env[key] !== undefined && !['PATH', 'SystemRoot', 'WINDIR', 'SystemDrive', 'TEMP', 'TMP'].includes(key)), []);
  assert.equal(call.options.env.NODE_V8_COVERAGE, undefined);
  assert.equal(call.options.env.TEMP, call.options.cwd);
  assert.equal(call.options.env.COMPILER_TEST_CREDENTIAL, undefined);
  const result = await pending;
  assert.deepEqual(result, { artifact: Buffer.from('raw artifact bytes'), diagnostics: [] });
  await cleaned(call);
});

test('one slot is held across exit until close and cleanup, then recovers', async t => {
  const f = fixture(t, okScript, { holdClose: true });
  const compiler = createCompiler({ modelBytes: model }, { launch: f.launch });
  let settled = false;
  const pending = compiler.compile(source).finally(() => { settled = true; });
  await f.onHeldClose;
  assert.equal(settled, false);
  await access(f.calls[0].options.cwd);
  await assert.rejects(compiler.compile(source), isError('COMPILER_BUSY', 429));
  assert.equal(f.calls.length, 1);
  f.calls[0].release();
  await pending;
  await cleaned(f.calls[0]);
  await compiler.compile(source);
  await cleaned(f.calls[1]);
});

test('source ceiling is inclusive and rejects overflow before child launch', async t => {
  const f = fixture(t);
  const compiler = createCompiler({ modelBytes: model }, { launch: f.launch });
  await assert.rejects(compiler.compile(Buffer.alloc(65_537)), limit);
  assert.equal(f.calls.length, 0);
  const result = await compiler.compile(Buffer.alloc(65_536, 32));
  assert.ok(Buffer.isBuffer(result.artifact));
  assert.equal(f.calls.length, 1);
  const invalid = await compiler.compile('not bytes');
  assert.equal(invalid.artifact, null);
  assert.equal(invalid.diagnostics[0].code, 'SYNTAX_INVALID');
  assert.equal(f.calls.length, 1);
});

test('stdout limit is inclusive and overflow is a whole-tool failure', async t => {
  const exact = fixture(t, 'process.stdout.end(Buffer.alloc(1048576, 65));');
  assert.equal((await createCompiler({ modelBytes: model }, { launch: exact.launch }).compile(source)).artifact.length, 1_048_576);
  await cleaned(exact.calls[0]);
  const over = fixture(t, 'process.stdout.end(Buffer.alloc(1048577, 65));');
  await assert.rejects(createCompiler({ modelBytes: model }, { launch: over.launch }).compile(source), limit);
  await cleaned(over.calls[0]);
});

test('stderr overflow defeats even previously emitted successful output', async t => {
  const f = fixture(t, "process.stdout.write('artifact'); process.stderr.end(Buffer.alloc(20098, 65));");
  await assert.rejects(createCompiler({ modelBytes: model }, { launch: f.launch }).compile(source), limit);
  await cleaned(f.calls[0]);
});

test('stderr diagnostic ceiling is inclusive and one extra byte rejects the entire output', async t => {
  const make = size => {
    const item = [{ code: 'TYPE_MISMATCH', path: '/source', message: '' }];
    item[0].message = 'x'.repeat(size - Buffer.byteLength(JSON.stringify(item)));
    const bytes = JSON.stringify(item);
    assert.equal(Buffer.byteLength(bytes), size);
    return `process.stderr.end(${JSON.stringify(bytes)}); process.exitCode=1;`;
  };
  const exact = fixture(t, make(16_384));
  const accepted = await createCompiler({ modelBytes: model }, { launch: exact.launch }).compile(source);
  assert.equal(accepted.artifact, null);
  assert.equal(accepted.diagnostics[0].message, 'The value does not match the required type.');
  const over = fixture(t, make(16_385));
  await assert.rejects(createCompiler({ modelBytes: model }, { launch: over.launch }).compile(source), limit);
  await cleaned(over.calls[0]);
});

test('native rejection is safe data with only validated structural locations', async t => {
  const native = [{ code: 'FIELD_UNKNOWN', path: '/source/steps/0/args/SECRET_VALUE', message: 'SECRET filesystem path and source snippet' }];
  const f = fixture(t, `process.stderr.end(${JSON.stringify(JSON.stringify(native))}); process.exitCode=1;`);
  const result = await createCompiler({ modelBytes: model }, { launch: f.launch }).compile(source);
  assert.equal(result.artifact, null);
  assert.deepEqual(result.diagnostics, [{ code: 'FIELD_UNKNOWN', path: '/source/steps/0/args', message: 'The document contains an unknown field.' }]);
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
  assert.equal(Object.isFrozen(result.diagnostics[0]), true);
  await cleaned(f.calls[0]);
});

test('empty, malformed, unknown and nonzero process responses fail safely', async t => {
  for (const script of [
    '', "process.stderr.end('private exception'); process.exitCode=1;",
    "process.stdout.end('prefix'); process.exitCode=1;",
    "process.stdout.end('artifact'); process.stderr.end('warning');",
    `process.stderr.end(${JSON.stringify(JSON.stringify([{ code: 'UNKNOWN', path: '/source', message: 'x' }]))}); process.exitCode=1;`,
    `process.stderr.end(${JSON.stringify(JSON.stringify([{ code: 'TYPE_MISMATCH', path: 'C:/private', message: 'x' }]))}); process.exitCode=1;`,
    `process.stderr.end(${JSON.stringify(JSON.stringify([{ code: ['TYPE_MISMATCH'], path: '/source', message: 'x' }]))}); process.exitCode=1;`,
    "process.stderr.end(Buffer.from([255])); process.exitCode=1;",
    `process.stderr.end(${JSON.stringify('\uFEFF' + JSON.stringify([{ code: 'TYPE_MISMATCH', path: '/source', message: 'x' }]))}); process.exitCode=1;`,
    "process.stderr.end('[]'); process.exitCode=2;",
  ]) {
    const f = fixture(t, script);
    await assert.rejects(createCompiler({ modelBytes: model }, { launch: f.launch }).compile(source), error => failed(error) && !error.message.includes('private'));
    await cleaned(f.calls[0]);
  }
});

test('pre-cancellation and malformed signals never start a child', async t => {
  const f = fixture(t);
  const compiler = createCompiler({ modelBytes: model }, { launch: f.launch });
  const signal = AbortSignal.abort();
  await assert.rejects(compiler.compile(source, { signal }), isError('COMPILER_CANCELLED', 499));
  await assert.rejects(compiler.compile(source, { signal: {} }), failed);
  assert.equal(f.calls.length, 0);
});

test('cancellation kills only its child and holds the slot until close', async t => {
  const f = fixture(t, ['setInterval(()=>{},10000);', okScript], { holdClose: true });
  const compiler = createCompiler({ modelBytes: model }, { launch: f.launch });
  const abort = new AbortController();
  const pending = compiler.compile(source, { signal: abort.signal });
  const rejected = assert.rejects(pending, isError('COMPILER_CANCELLED', 499));
  await f.onStart;
  abort.abort();
  await f.onHeldClose;
  await assert.rejects(compiler.compile(source), isError('COMPILER_BUSY', 429));
  await access(f.calls[0].options.cwd);
  f.calls[0].release();
  await rejected;
  await cleaned(f.calls[0]);
  await compiler.compile(source);
  await cleaned(f.calls[1]);
});

test('deadline escalates an unresponsive owned child and reaps before returning', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t, ['setInterval(()=>{},10000);', okScript], { ignoreTerm: true });
  const compiler = createCompiler({ modelBytes: model }, { launch: f.launch, killGraceMs: 25 });
  const pending = compiler.compile(source);
  const rejected = assert.rejects(pending, isError('COMPILER_TIMEOUT', 504));
  await f.onStart;
  t.mock.timers.tick(10_001);
  assert.deepEqual(f.calls[0].signals, ['SIGTERM']);
  t.mock.timers.tick(25);
  await rejected;
  assert.deepEqual(f.calls[0].signals, ['SIGTERM', 'SIGKILL']);
  await cleaned(f.calls[0]);
  t.mock.timers.reset();
  await compiler.compile(source);
  await cleaned(f.calls[1]);
});

test('cancellation observed during close/cleanup cannot return an artifact', async t => {
  const f = fixture(t);
  const abort = new AbortController();
  const launch = (...args) => {
    const child = f.launch(...args);
    child.once('close', () => queueMicrotask(() => abort.abort()));
    return child;
  };
  await assert.rejects(createCompiler({ modelBytes: model }, { launch }).compile(source, { signal: abort.signal }), isError('COMPILER_CANCELLED', 499));
  await cleaned(f.calls[0]);
});

test('synchronous launch failure cleans up and recovers without waiting for an absent child', async t => {
  const f = fixture(t);
  let count = 0, directory;
  const launch = (...args) => {
    if (count++ === 0) { directory = args[2].cwd; throw new Error('private launch failure'); }
    return f.launch(...args);
  };
  const compiler = createCompiler({ modelBytes: model }, { launch });
  await assert.rejects(compiler.compile(source), unavailable);
  await assert.rejects(access(directory), { code: 'ENOENT' });
  await compiler.compile(source);
  await cleaned(f.calls[0]);
});

test('late events after close cannot change a result or poison the next slot', async t => {
  const f = fixture(t);
  const compiler = createCompiler({ modelBytes: model }, { launch: f.launch });
  const first = await compiler.compile(source);
  f.calls[0].child.emit('error', new Error('private late exception'));
  f.calls[0].child.emit('close', 1);
  f.calls[0].child.stderr.emit('data', Buffer.alloc(20_000));
  assert.deepEqual(first.artifact, Buffer.from('raw artifact bytes'));
  await compiler.compile(source);
  await cleaned(f.calls[1]);
});

test('missing Java is compile-only unavailability and leaves no occupied slot', async t => {
  const directory = await temporary(t);
  const compiler = createCompiler({ modelBytes: model, javaExecutable: join(directory, 'missing-java') });
  await assert.rejects(compiler.compile(source), unavailable);
  await assert.rejects(compiler.compile(source), unavailable);
});

test('bad or missing distribution pins never execute and recover after repair', async t => {
  const directory = await temporary(t);
  const f = fixture(t);
  const compiler = createCompiler({ modelBytes: model }, { launch: f.launch, distributionDirectory: directory });
  await assert.rejects(compiler.compile(source), unavailable);
  for (const name of [jarName, 'compiler-provenance.json']) await cp(join(vendor, name), join(directory, name));
  const info = JSON.parse(await readFile(join(directory, 'compiler-provenance.json')));
  info.artifact.sha256 = 'sha256:' + '0'.repeat(64);
  await writeFile(join(directory, 'compiler-provenance.json'), JSON.stringify(info));
  await assert.rejects(compiler.compile(source), unavailable);
  await cp(join(vendor, 'compiler-provenance.json'), join(directory, 'compiler-provenance.json'));
  const altered = await readFile(join(directory, jarName)); altered[0] ^= 1;
  await writeFile(join(directory, jarName), altered);
  await assert.rejects(compiler.compile(source), unavailable);
  assert.equal(f.calls.length, 0);
  await cp(join(vendor, jarName), join(directory, jarName));
  await compiler.compile(source);
  await cleaned(f.calls[0]);
});

test('trusted test budgets cannot widen production ceilings or use a missing model', async () => {
  await assert.rejects(createCompiler({ modelBytes: model }, { timeoutMs: 10_001 }).compile(source), unavailable);
  await assert.rejects(createCompiler({ modelBytes: model }, { killGraceMs: 251 }).compile(source), unavailable);
  await assert.rejects(createCompiler().compile(source), unavailable);
});

test('explicit trusted definition retains the same compiler slot and exact model/profile', async t => {
  const f = fixture(t, okScript, { holdClose: true });
  const compiler = createCompiler({}, { launch: f.launch });
  const definition = loadHost();
  const pending = compiler.compile(source, { definition });
  definition.dcmBytes.fill(0);
  definition.pins.profile = 'keir-effect/3';
  await f.onHeldClose;
  await assert.rejects(compiler.compile(source, { definition: loadHost(TASK_HOOK) }), isError('COMPILER_BUSY', 429));
  assert.deepEqual(await readFile(f.calls[0].args[7]), model);
  assert.equal(f.calls[0].args.at(-1), '--profile=keir-read/2');
  f.calls[0].release();
  await pending;
  await cleaned(f.calls[0]);
});

test('untrusted definition/profile/model is rejected without launching a compiler', async t => {
  const f = fixture(t), compiler = createCompiler({}, { launch: f.launch }), definition = loadHost();
  for (const changed of [
    { ...definition, definitionId: 'customer-definition' },
    { ...definition, pins: { ...definition.pins, profile: 'keir-effect/3' } },
    { ...definition, pins: { ...definition.pins, hook: TASK_HOOK } },
    { ...definition, dcmBytes: Buffer.from('{}') },
    { ...definition, pins: { ...definition.pins, consumer: { id: 'customer-consumer', version: '1', kind: 'EVENT_REPORT' } } },
  ]) await assert.rejects(compiler.compile(source, { definition: changed }), unavailable);
  assert.equal(f.calls.length, 0);
});

const java = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java';
const checked = spawnSync(java, ['-version'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
const qualifiedJava = checked.status === 0 && /version "(?:2[1-9]|[3-9][0-9])\./.test(checked.stderr ?? '');

test('actual pinned compiler works from a standalone directory and preserves raw/canonical identity distinction', { skip: !qualifiedJava && !process.env.CI }, async t => {
  assert.ok(qualifiedJava, 'Qualified Java 21 is required for compiler qualification in CI.');
  const directory = await temporary(t);
  await cp(join(root, 'src/compiler.mjs'), join(directory, 'src/compiler.mjs'));
  for (const name of [jarName, 'compiler-provenance.json', 'compiler-NOTICES.txt']) await cp(join(vendor, name), join(directory, 'vendor', name));
  const imported = await import(pathToFileURL(join(directory, 'src/compiler.mjs')));
  const compiler = imported.createCompiler({ modelBytes: model, javaExecutable: java });
  const first = await compiler.compile(source);
  assert.deepEqual(first.artifact, expected);
  assert.deepEqual(first.diagnostics, []);
  const changed = Buffer.concat([source, Buffer.from('\n  \n')]);
  const second = await compiler.compile(changed);
  assert.notEqual(sha(source), sha(changed));
  assert.deepEqual(second.artifact, first.artifact);
  const invalid = await compiler.compile(Buffer.from('{'));
  assert.equal(invalid.artifact, null);
  assert.equal(invalid.diagnostics[0].code, 'SYNTAX_INVALID');
  const excessiveDiagnostic = Buffer.from(JSON.stringify({ language: 'keir/v0', ['x'.repeat(20_000)]: false }));
  await assert.rejects(compiler.compile(excessiveDiagnostic), error => error.code === 'COMPILER_LIMIT' && error.status === 413);
});
