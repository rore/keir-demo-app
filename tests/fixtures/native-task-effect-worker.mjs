import { writeSync } from 'node:fs';
import { openData, taskService, transaction } from '../../src/data.mjs';
import { nativeEffectService } from './task-effect-schema.mjs';

const config = JSON.parse(process.argv[2]);
const db = openData(config.path);
db.exec('PRAGMA busy_timeout=10000');
const effects = nativeEffectService(db);
const report = message => writeSync(1, `${JSON.stringify(message)}\n`);
const hold = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);

if (config.boundary === 'before') {
  db.function('test_crash_barrier', () => {
    report({ type: 'boundary', boundary: 'before' });
    hold();
    return 0;
  });
  const triggers = {
    complete: 'AFTER INSERT ON task_completion_events',
    claim: "AFTER UPDATE OF state ON task_completion_events WHEN NEW.state='STARTED'",
    create: 'AFTER INSERT ON task_effect_receipts',
    finish: "AFTER UPDATE OF state ON task_completion_events WHEN NEW.state='FINISHED'",
  };
  db.exec(`CREATE TEMP TRIGGER test_crash_boundary ${triggers[config.operation]} BEGIN SELECT test_crash_barrier(); END`);
}

process.once('message', () => {
  try {
    let result;
    switch (config.operation) {
      case 'select':
        result = transaction(db, () => db.prepare("UPDATE extension_selections SET revision_id=?,generation=1,binding_pins=? WHERE owner_id=? AND hook_id='TaskCompleted'")
          .run(config.selection.revisionId, JSON.stringify(config.selection.pins), config.owner));
        break;
      case 'complete': result = taskService(db).completeTask(config.owner, config.taskId); break;
      case 'claim': result = effects.claim(config.owner, config.eventId); break;
      case 'create': result = effects.createTaskOnce(config.owner, effects.keyFor(config.owner, config.eventId), config.payload); break;
      case 'finish': result = effects.finish(config.owner, config.eventId, config.outcome); break;
      default: throw new Error('Unsupported fixture operation');
    }
    if (config.boundary === 'after') {
      report({ type: 'boundary', boundary: 'after' });
      hold();
    }
    report({ type: 'result', result });
    db.close();
    process.disconnect();
  } catch (error) {
    report({ type: 'error', message: error.message, code: error.code });
    db.close();
    process.disconnect();
    process.exitCode = 1;
  }
});
report({ type: 'ready' });
