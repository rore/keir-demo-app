import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openData, taskService } from '../src/data.mjs';
import { createCompiler } from '../src/compiler.mjs';
import { createLifecycle } from '../src/extension-lifecycle.mjs';
import { createAuthoringService } from '../src/authoring-service.mjs';

// Imported by an explicit operator command; construction alone performs no external work.
export function createQualificationHost({ env = process.env } = {}) {
  return {
    inputs: [{ id: 'qualification-request', text: 'When I complete a task in the existing project named Qualification project, create a task titled Review completed work in that same project. '
      + 'Discover the supported contract and actual existing project IDs; do not guess IDs or use placeholder constants. Author my project and title choices in source. '
      + 'Independently expect one creation for a completed task in that project, none for another project, and no claimed creation when the source is missing, denied or temporarily unavailable. '
      + 'A later human completion of the created task is a new occurrence and should match again. Use those expectations to author the example cases before checking. '
      + 'Prepare and check the exact change, then offer review. Do not approve, activate, complete a real task or create a real task.' }],
    async runCheck({ config, inputs, fetchImpl }) {
      const prefix = join(tmpdir(), 'keir-ai-qualification-');
      const directory = await mkdtemp(prefix);
      let db, service;
      try {
        db = openData(join(directory, 'qualification.sqlite'));
        taskService(db).createProject('sam', { name: 'Qualification project' });
        const nativeBefore = JSON.stringify(db.prepare('SELECT * FROM tasks ORDER BY id').all());
        const selectionsBefore = JSON.stringify(db.prepare('SELECT * FROM extension_selections ORDER BY owner_id,hook_id').all());
        const compiler = createCompiler({ javaExecutable: env.KEIR_JAVA_BIN });
        const lifecycle = createLifecycle(db, { compiler });
        service = createAuthoringService({ db, lifecycle, config, fetchImpl });
        const lease = { sessionId: 'qualification-session', current: () => true };
        let conversation = null;
        for (const input of inputs) {
          const accepted = await service.turn('sam', { conversationId: conversation?.id ?? null, operationId: input.id,
            target: conversation ? { kind: 'resume', extensionId: conversation.extensionId } : { kind: 'create' },
            text: input.text, expectedVersion: conversation?.version ?? 0,
            expectedDraftVersion: conversation ? lifecycle.state('sam', conversation.extensionId).draftVersion : 0 }, lease);
          conversation = await service.wait('sam', accepted.conversation.id);
          if (conversation.status !== 'AWAITING_USER') break;
        }
        const state = JSON.parse(db.prepare('SELECT state FROM authoring_conversations WHERE id=?').get(conversation.id).state);
        if (JSON.stringify(db.prepare('SELECT * FROM tasks ORDER BY id').all()) !== nativeBefore
            || JSON.stringify(db.prepare('SELECT * FROM extension_selections ORDER BY owner_id,hook_id').all()) !== selectionsBefore
            || db.prepare('SELECT count(*) n FROM extension_approvals').get().n !== 0) throw new Error('Authoring changed native tasks or human decisions');
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
