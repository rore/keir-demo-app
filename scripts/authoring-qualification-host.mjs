import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openData } from '../src/data.mjs';
import { loadHost } from '../src/extension-catalog.mjs';
import { createCompiler } from '../src/compiler.mjs';
import { createLifecycle, simulationCases } from '../src/extension-lifecycle.mjs';
import { createAuthoringService } from '../src/authoring-service.mjs';

// Imported by an explicit operator command; construction alone performs no external work.
export function createQualificationHost({ env = process.env } = {}) {
  // Host denial is a separate protection test; authored suites cannot choose host permission.
  const examples = simulationCases('pending').filter(item => item.id !== 'host-denied').map(item => item.bytes.toString('utf8'));
  return {
    inputs: [{ id: 'qualification-request', text: 'Discover the host contract and author task advice: OPEN tasks show PENDING and COMPLETED tasks show DONE. '
      + 'Use the discovered source example, compile it, save these independent original scenario strings, simulate, and offer exact review. '
      + 'Do not approve or activate. Independent cases: ' + JSON.stringify(examples) }],
    async runCheck({ config, inputs, fetchImpl }) {
      const prefix = join(tmpdir(), 'keir-ai-qualification-');
      const directory = await mkdtemp(prefix);
      let db, service;
      try {
        db = openData(join(directory, 'qualification.sqlite'));
        const compiler = createCompiler({ modelBytes: loadHost().dcmBytes, javaExecutable: env.KEIR_JAVA_BIN });
        const lifecycle = createLifecycle(db, { compiler });
        service = createAuthoringService({ db, lifecycle, config, fetchImpl });
        const lease = { sessionId: 'qualification-session', current: () => true };
        let conversation = null;
        for (const input of inputs) {
          const accepted = await service.turn('sam', { conversationId: conversation?.id ?? null, operationId: input.id,
            text: input.text, expectedVersion: conversation?.version ?? 0, expectedDraftVersion: lifecycle.state('sam').draftVersion }, lease);
          conversation = await service.wait('sam', accepted.conversation.id);
          if (conversation.status !== 'AWAITING_USER') break;
        }
        const state = JSON.parse(db.prepare('SELECT state FROM authoring_conversations WHERE id=?').get(conversation.id).state);
        return { status: conversation.status, ...(conversation.code && { code: conversation.code }), provider: config.provider, model: config.model,
          counts: state.counts, usage: state.usage, ...(conversation.review && { review: conversation.review }) };
      } finally {
        await service?.close(); db?.close();
        if (!directory.startsWith(prefix)) throw new Error('Unexpected qualification directory');
        await rm(directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 25 });
      }
    },
  };
}
