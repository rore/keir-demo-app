import { randomUUID } from 'node:crypto';
import { constants, openSync, closeSync, fstatSync, readSync, writeFileSync, fsyncSync, readFileSync, renameSync, unlinkSync,
  lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, resolve, relative, isAbsolute, join } from 'node:path';
import { AppError } from './data.mjs';
import { readAuthoringConfig, readSetupConfig } from './authoring-config.mjs';

const LIMIT = 8192;
const invalid = () => Object.freeze({ status: 'unavailable', code: 'AI_CONFIG_INVALID' });
const failure = (status, code, message) => { const error = new AppError(status, message); error.code = code; return error; };
const saveFailed = () => failure(503, 'AI_CONFIG_SAVE_FAILED', 'Settings could not be saved. The previous configuration remains in use.');

function realLocation(path) {
  try { return realpathSync(path); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(realLocation(parent), basename(path));
  }
}

export function assertAuthoringSettingsLocation(file, staticRoot) {
  if (!file) return;
  try {
    if (!isAbsolute(file) || basename(file) !== 'ai-authoring.json') throw Error();
    const location = realLocation(resolve(dirname(file))), root = realLocation(resolve(staticRoot));
    const path = relative(root, location);
    if (path === '' || !isAbsolute(path) && path !== '..' && !path.startsWith('..' + (process.platform === 'win32' ? '\\' : '/'))) throw Error();
  } catch { throw new Error('AI settings must use a data directory outside public assets.'); }
}

function regularTarget(file) {
  try { const stat = lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink()) throw Error(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function load(file) {
  let fd;
  try {
    regularTarget(file);
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > LIMIT) return invalid();
    const bytes = Buffer.alloc(LIMIT + 1); let size = 0, count;
    while (size < bytes.length && (count = readSync(fd, bytes, size, bytes.length - size, null)) > 0) size += count;
    if (size > LIMIT) return invalid();
    const saved = JSON.parse(bytes.subarray(0, size).toString('utf8'));
    const fields = ['version', 'revision', 'provider', 'model', 'apiKey', 'maxUsd'];
    if (!saved || typeof saved !== 'object' || Array.isArray(saved) || Object.keys(saved).length !== fields.length
        || fields.some(field => !Object.hasOwn(saved, field)) || saved.version !== 1
        || typeof saved.revision !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(saved.revision)) return invalid();
    return readSetupConfig({ provider: saved.provider, model: saved.model, apiKey: saved.apiKey, maxUsd: saved.maxUsd }, saved.revision);
  } catch (error) { return error.code === 'ENOENT' ? null : invalid(); }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function createAuthoringSettings({ file, env = process.env, config } = {}) {
  const local = file && config === undefined ? load(file) : null;
  let current = local ?? config ?? readAuthoringConfig(env);
  let source = local ? 'local' : current.status === 'ready' || current.code !== 'AI_NOT_CONFIGURED' ? 'environment' : 'none';
  return {
    get config() { return current; },
    publicConfiguration() {
      const ready = current.status === 'ready';
      const micros = ready ? BigInt(current.maxMicros) : null;
      const maxUsd = ready ? `${micros / 1000000n}.${String(micros % 1000000n).padStart(6, '0')}`.replace(/\.?0+$/, '') : null;
      return { status: current.status, code: ready ? null : current.code, source,
        provider: ready ? current.provider : null, model: ready ? current.model : null, maxUsd };
    },
    prepare(input) {
      const revision = randomUUID(), next = readSetupConfig(input, revision);
      if (next.status !== 'ready') throw failure(400, next.code, next.code === 'AI_CREDENTIALS_MISSING'
        ? 'Enter a nonempty printable API key of at most 4096 characters.' : 'Choose a supported provider/model and a positive decimal allowance with up to six decimal places.');
      const bytes = Buffer.from(JSON.stringify({ version: 1, revision, ...input }));
      if (bytes.length > LIMIT) throw failure(400, 'AI_CONFIG_INVALID', 'These settings exceed the local storage size limit. Enter a shorter API key.');
      return { config: next, persist() {
        if (!file) throw saveFailed();
        const temporary = join(dirname(file), `.ai-authoring-${randomUUID()}.tmp`);
        let fd, created = false;
        try {
          regularTarget(file);
          fd = openSync(temporary, 'wx', 0o600); created = true;
          writeFileSync(fd, bytes); fsyncSync(fd); closeSync(fd); fd = undefined;
          if (!readFileSync(temporary).equals(bytes)) throw Error();
          regularTarget(file); renameSync(temporary, file); created = false;
        } catch { throw saveFailed(); }
        finally {
          if (fd !== undefined) closeSync(fd);
          if (created) { try { unlinkSync(temporary); } catch { /* Only this operation's temporary file is eligible for cleanup. */ } }
        }
        current = next; source = 'local';
      } };
    },
  };
}
