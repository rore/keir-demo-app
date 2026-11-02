import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const JAR = 'keir-compiler-java-0.1.0-SNAPSHOT-cli.jar';
const JAR_BYTES = 8_814_077;
const JAR_HASH = '9196102bfac620fa038ca6e562c5ebb12e71350042722a9dcf20d5969d84c469';
const IDENTITY = 'keir-compiler-java/0.1.0-SNAPSHOT';
const PROFILE = 'keir-read/2';
const SOURCE_LIMIT = 65_536, OUTPUT_LIMIT = 1_048_576, ERROR_LIMIT = 16_384;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const failures = {
  COMPILER_UNAVAILABLE: [503, 'Source compilation is unavailable. Check the qualified Java and compiler setup.'],
  COMPILER_BUSY: [429, 'Another source compilation is running. Try again when it finishes.'],
  COMPILER_LIMIT: [413, 'Source compilation exceeded its input or output limit.'],
  COMPILER_TIMEOUT: [504, 'Source compilation exceeded its time limit.'],
  COMPILER_CANCELLED: [499, 'Source compilation was cancelled.'],
  COMPILER_FAILED: [500, 'Source compilation could not finish safely.'],
};
const messages = {
  SYNTAX_INVALID: 'The document does not match the required syntax.',
  FIELD_UNKNOWN: 'The document contains an unknown field.',
  PROFILE_UNSUPPORTED: 'The construct is outside the selected profile.',
  PIN_MISMATCH: 'The selected model or environment does not match.',
  DCM_INVALID: 'The domain model is invalid.',
  CAPABILITY_UNKNOWN: 'The capability is not declared.',
  ENTRY_GRANT_DENIED: 'The entrypoint does not grant this call.',
  HOST_BINDING_OVERRIDE: 'A protected parameter cannot be supplied by source.',
  NOMINAL_MISMATCH: 'The nominal types do not match.',
  ENUM_MISMATCH: 'The value does not match the required enum.',
  DATAFLOW_UNAVAILABLE: 'The binding name is unavailable.',
  CEL_POLICY_DENIED: 'The checked expression is outside the allowed profile.',
  BUDGET_EXCEEDED: 'A profile admission limit was exceeded.',
  TYPE_MISMATCH: 'The value does not match the required type.',
};
const structural = new Set(('domain id version fingerprint entrypoint name language steps return record args call let cel literal type when onError '
  + 'capabilities parameters types fields consumer kind grants capabilityPolicy format effect input output errors values binding').split(' '));

export class CompilerError extends Error {
  constructor(code) {
    const chosen = Object.hasOwn(failures, code) ? code : 'COMPILER_FAILED';
    super(failures[chosen][1]);
    this.name = 'CompilerError';
    this.code = chosen;
    this.status = failures[chosen][0];
  }
}
const failure = code => new CompilerError(code);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function readBounded(path, limit) {
  const file = await open(path, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit) throw failure('COMPILER_UNAVAILABLE');
    const bytes = Buffer.allocUnsafe(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const next = await file.read(bytes, length, bytes.length - length, null);
      if (!next.bytesRead) break;
      length += next.bytesRead;
    }
    if (length > limit) throw failure('COMPILER_UNAVAILABLE');
    return bytes.subarray(0, length);
  } finally { await file.close(); }
}

function diagnostics(bytes) {
  try {
    const parsed = JSON.parse(utf8.decode(bytes));
    if (!Array.isArray(parsed) || parsed.length !== 1) throw 0;
    const item = parsed[0];
    if (!item || Object.keys(item).sort().join() !== 'code,message,path' || typeof item.code !== 'string' || !Object.hasOwn(messages, item.code)
      || typeof item.message !== 'string' || typeof item.path !== 'string') throw 0;
    const [empty, root, ...parts] = item.path.split('/');
    if (empty !== '' || !['source', 'dcm'].includes(root)) throw 0;
    let path = '/' + root;
    for (const part of parts) {
      if (!(structural.has(part) || /^(?:0|[1-9][0-9]?)$/.test(part)) || path.length + part.length + 1 > 256) break;
      path += '/' + part;
    }
    return Object.freeze([Object.freeze({ code: item.code, path, message: messages[item.code] })]);
  } catch { throw failure('COMPILER_FAILED'); }
}

function childEnvironment(directory) {
  // Node otherwise copies its coverage directory even into an explicit environment.
  const env = { NODE_V8_COVERAGE: undefined };
  for (const key of ['SystemRoot', 'WINDIR', 'SystemDrive', 'PATH']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.TEMP = directory;
  env.TMP = directory;
  return env;
}

function runChild(java, directory, signal, launch, timeoutMs, killGraceMs) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = launch(java, ['-Xmx256m', '-Djava.io.tmpdir=' + directory, '-Duser.home=' + directory,
        '-jar', join(directory, 'compiler.jar'), join(directory, 'source.input'), join(directory, 'dcm.json'), '--profile=' + PROFILE],
      { cwd: directory, env: childEnvironment(directory), shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch { reject(failure('COMPILER_UNAVAILABLE')); return; }
    let closed = false, stopped, killTimer;
    const stdout = [], stderr = [];
    let outputBytes = 0, errorBytes = 0;
    function stop(reason) {
      if (closed || stopped) return;
      stopped = reason;
      stdout.length = 0; stderr.length = 0;
      try { child.kill('SIGTERM'); } catch { /* Escalation still targets only this child. */ }
      killTimer = setTimeout(() => {
        if (!closed) { try { child.kill('SIGKILL'); } catch { /* Retain ownership until close. */ } }
      }, killGraceMs);
      killTimer.unref?.();
    }
    const cancel = () => stop(failure('COMPILER_CANCELLED'));
    const timer = setTimeout(() => stop(failure('COMPILER_TIMEOUT')), timeoutMs);
    timer.unref?.();
    signal?.addEventListener('abort', cancel, { once: true });
    child.on('error', error => {
      if (!closed) stop(failure(['ENOENT', 'EACCES', 'ENOTDIR'].includes(error.code) ? 'COMPILER_UNAVAILABLE' : 'COMPILER_FAILED'));
    });
    child.stdout?.on('data', chunk => {
      if (closed || stopped) return;
      outputBytes += chunk.length;
      if (outputBytes > OUTPUT_LIMIT) stop(failure('COMPILER_LIMIT'));
      else stdout.push(Buffer.from(chunk));
    });
    child.stderr?.on('data', chunk => {
      if (closed || stopped) return;
      errorBytes += chunk.length;
      if (errorBytes > ERROR_LIMIT) stop(failure('COMPILER_LIMIT'));
      else stderr.push(Buffer.from(chunk));
    });
    child.stdout?.on('error', () => stop(failure('COMPILER_FAILED')));
    child.stderr?.on('error', () => stop(failure('COMPILER_FAILED')));
    child.once('close', code => {
      closed = true;
      clearTimeout(timer); clearTimeout(killTimer);
      signal?.removeEventListener('abort', cancel);
      if (stopped) { reject(stopped); return; }
      try {
        if (code === 0 && outputBytes > 0 && errorBytes === 0) {
          resolve({ artifact: Buffer.concat(stdout, outputBytes), diagnostics: Object.freeze([]) });
        } else if (code === 1 && outputBytes === 0 && errorBytes > 0) {
          resolve({ artifact: null, diagnostics: diagnostics(Buffer.concat(stderr, errorBytes)) });
        } else reject(failure('COMPILER_FAILED'));
      } catch { reject(failure('COMPILER_FAILED')); }
    });
    if (!child.stdout || !child.stderr) stop(failure('COMPILER_FAILED'));
    if (signal?.aborted) cancel();
  });
}

// The second argument contains trusted test seams, never request-controlled configuration.
export function createCompiler({ modelBytes, javaExecutable } = {}, {
  launch = spawn, timeoutMs = 10_000, killGraceMs = 250,
  distributionDirectory = fileURLToPath(new URL('../vendor/', import.meta.url)),
} = {}) {
  const model = modelBytes instanceof Uint8Array && modelBytes.byteLength <= SOURCE_LIMIT ? Buffer.from(modelBytes) : null;
  const java = javaExecutable ?? (process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java');
  const configured = model?.length && typeof java === 'string' && java.length > 0
    && Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 10_000
    && Number.isInteger(killGraceMs) && killGraceMs > 0 && killGraceMs <= 250;
  let active = false;
  return Object.freeze({
    async compile(sourceBytes, { signal } = {}) {
      if (signal !== undefined && !(signal instanceof AbortSignal)) throw failure('COMPILER_FAILED');
      if (signal?.aborted) throw failure('COMPILER_CANCELLED');
      if (active) throw failure('COMPILER_BUSY');
      if (!configured) throw failure('COMPILER_UNAVAILABLE');
      if (!(sourceBytes instanceof Uint8Array)) return { artifact: null, diagnostics: Object.freeze([Object.freeze({ code: 'SYNTAX_INVALID', path: '/source', message: messages.SYNTAX_INVALID })]) };
      if (sourceBytes.byteLength > SOURCE_LIMIT) throw failure('COMPILER_LIMIT');
      const source = Buffer.from(sourceBytes);
      active = true;
      const started = performance.now();
      let directory;
      function check() {
        if (signal?.aborted) throw failure('COMPILER_CANCELLED');
        if (performance.now() - started >= timeoutMs) throw failure('COMPILER_TIMEOUT');
      }
      try {
        let jar;
        try {
          const metadata = JSON.parse(utf8.decode(await readBounded(join(distributionDirectory, 'compiler-provenance.json'), SOURCE_LIMIT)));
          if (metadata.compiler !== IDENTITY || metadata.profile !== PROFILE || metadata.artifact?.file !== JAR
            || metadata.artifact.bytes !== JAR_BYTES || metadata.artifact.sha256 !== 'sha256:' + JAR_HASH) throw 0;
          jar = await readBounded(join(distributionDirectory, JAR), JAR_BYTES);
          if (jar.length !== JAR_BYTES || hash(jar) !== JAR_HASH) throw 0;
        } catch { check(); throw failure('COMPILER_UNAVAILABLE'); }
        check();
        directory = await mkdtemp(join(tmpdir(), 'keir-compile-'));
        for (const [name, bytes] of [['compiler.jar', jar], ['source.input', source], ['dcm.json', model]]) {
          await writeFile(join(directory, name), bytes, { flag: 'wx', mode: 0o600 });
          check();
        }
        return await runChild(java, directory, signal, launch, timeoutMs - (performance.now() - started), killGraceMs);
      } catch (error) {
        if (error instanceof CompilerError) throw error;
        throw failure('COMPILER_FAILED');
      } finally {
        try {
          if (directory) await rm(directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 25 });
        } catch { throw failure('COMPILER_FAILED'); }
        // Failed cleanup deliberately retains the slot instead of accumulating private jobs.
        active = false;
        if (signal?.aborted) throw failure('COMPILER_CANCELLED');
      }
    },
  });
}
