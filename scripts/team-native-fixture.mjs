import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openData, taskService } from '../src/data.mjs';
import { createCompiler } from '../src/compiler.mjs';
import { digest, json } from '../src/extension-catalog.mjs';
import { teamModelBytes, teamModel, installTeamRevision } from '../src/team-runtime.mjs';
import { teamProjectService } from '../src/team-native.mjs';

export async function compileTeamProgram(program) {
  const compiler = createCompiler({ modelBytes: teamModelBytes, javaExecutable: process.env.KEIR_JAVA_BIN });
  const domain = { ...teamModel.domain, fingerprint: digest(json(teamModel)) };
  const { artifact, diagnostics } = await compiler.compile(Buffer.from(JSON.stringify({ language: 'keir/3', domain, ...program })));
  if (!artifact || diagnostics.length) throw new Error('Team fixture compilation failed: ' + JSON.stringify(diagnostics));
  return artifact;
}

export async function compileTeamFixture() {
  const programs = JSON.parse(readFileSync(new URL('../keir/team-review-v1.json', import.meta.url)));
  const created = await compileTeamProgram(programs[0]), gate = await compileTeamProgram(programs[1]);
  const replacement = structuredClone(programs[0]);
  replacement.name = 'request-second-review';
  replacement.steps[1].args.title.literal = 'Check the revised deliverable';
  replacement.steps[1].args.assigneeId.literal = 'maya';
  return {
    first: { TaskCreated: created, TaskBeforeComplete: gate },
    second: { TaskCreated: await compileTeamProgram(replacement), TaskBeforeComplete: gate },
  };
}

export function seedTeamFixture(db, assets, { owner = 'maya', member = 'leo', name = 'Shared collection' } = {}) {
  const { id } = taskService(db).createProject(owner, { name, mode: 'TEAM' });
  teamProjectService(db).addMember(owner, id, { userId: member });
  installTeamRevision(db, owner, id, 'review-v1', assets.first);
  installTeamRevision(db, owner, id, 'review-v2', assets.second);
  teamProjectService(db).setSelection(owner, id, 'review-v1');
  return id;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/team-native-fixture.mjs <new-disposable-directory>');
  const assets = await compileTeamFixture(), directory = resolve(process.argv[2]);
  // Refuse any existing directory, even an empty one. This is never a live-data installer.
  mkdirSync(directory);
  const db = openData(join(directory, 'app.sqlite'));
  try { console.log(JSON.stringify({ projectId: seedTeamFixture(db, assets), disposable: true })); }
  finally { db.close(); }
}
