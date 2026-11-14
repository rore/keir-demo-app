import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { startAuthoringFixture } from '../fixtures/authoring-server.mjs';

test('conditional follow-up is authored, checked, approved, activated and saved through real native Tasks', async ({ page }) => {
  test.setTimeout(90_000);
  const f=await startAuthoringFixture({conditionalFollowUp:true,title:'Follow up'});
  const ui=page.getByRole('region',{name:'Customization Studio',exact:true});
  const button=(name,scope=page)=>scope.getByRole('button',{name,exact:true});
  const send=async text=>{await ui.getByLabel('Message to Daymark assistant',{exact:true}).fill(text);await button('Prepare changes',ui).click();};
  const navigate=async name=>button(name,page.getByRole('navigation',{name:'Main navigation'})).click();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  mkdirSync('build/core-040/screens',{recursive:true});
  try {
    await page.goto(f.origin);await page.getByRole('button',{name:/^Continue as Maya/}).click();
    await navigate('Customizations');await button('New customization').click();
    await button('Avoid another follow-up',ui).click();
    await expect(ui.getByLabel('Message to Daymark assistant',{exact:true})).toHaveValue(/high-priority/);
    const nativeBefore=f.db.prepare('SELECT * FROM tasks ORDER BY id').all();
    await send(`When a high-priority task in ${f.metadata.projectName} is completed, create Follow up in the same project only if no task with that exact title is already open there.`);
    await expect(ui.getByText(f.metadata.question,{exact:true})).toBeVisible();
    await send('Confirmed: only high-priority completions in that project. Other priorities and projects should do nothing. An unavailable lookup must not create anything.');
    await expect(ui.getByText(f.metadata.offerText,{exact:true})).toBeVisible({timeout:20_000});
    const id=new URLSearchParams(new URL(page.url()).hash.slice(1)).get('customization');
    const session=await(await page.request.get(f.origin+'/api/session')).json();
    const read=async path=>{const r=await page.request.get(f.origin+'/api/'+path,{headers:{'x-session-context':session.contextToken}});expect(r.ok(),await r.text()).toBe(true);return r.json();};
    const state=()=>read('extensions/'+id);
    const current=(await read('authoring?extensionId='+id)).current;
    const proof=await read(`extensions/${id}/evidence/${current.review.evidenceId}`);
    expect(proof.passed).toBe(true);expect(proof.reports).toHaveLength(6);
    expect(proof.reports[2].report.calls.map(c=>c.capability)).toEqual(['tasks.get']);
    expect(proof.reports[4].report.native.classification).toBe('FAILED');
    expect(proof.reports[4].report.observed.effect).toBe('NONE');
    await button('See proposed change',ui).first().click();
    await expect(ui.locator('.rs-rule-summary')).toContainText('High priority');
    await expect(ui.locator('.rs-rule-summary')).toContainText('no open task titled exactly “Follow up”');
    await expect(ui.locator('.rs-inline-behavior')).toContainText('simultaneous task completions');
    await expect(ui.locator('.rs-inline-behavior')).not.toContainText('full behavior could not be described');
    await page.screenshot({path:'build/core-040/screens/summary.png'});
    for(const viewport of [{width:320,height:740},{width:683,height:384}]){
      await page.setViewportSize(viewport);await button('See proposed change',ui).first().click();
      await expect(ui.getByRole('heading',{name:'Summary',exact:true})).toBeVisible();
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    }
    await page.setViewportSize({width:1440,height:1000});await button('View simulation',ui).click();
    const decision=ui.getByRole('article',{name:'Current decision',exact:true});
    await expect(button('Approve this change',decision)).toBeEnabled();
    await expect(decision).toContainText('Example tasks; your tasks are unchanged.');
    const oldSelection=(await state()).selection.revision?.id??null;
    await button('Approve this change',decision).click();
    expect((await state()).selection.revision?.id??null).toBe(oldSelection);
    await expect(button('Turn on for tasks completed',ui)).toBeEnabled();
    await button('Turn on for tasks completed',ui).click();
    await expect(ui.getByLabel('Customization status',{exact:true})).toContainText('On for my tasks');
    expect(f.db.prepare('SELECT * FROM tasks ORDER BY id').all()).toEqual(nativeBefore);
    const callCount=f.requests.length;
    const selected=await state();expect(selected.selection.revision.id).toBe(current.review.revisionId);
    await navigate('Tasks');
    await button(f.metadata.projectName,page.getByRole('navigation',{name:'Projects',exact:true})).click();
    const add=async(title,priority)=>{
      await page.getByLabel('New task title',{exact:true}).fill(title);await button('Details').click();
      const dialog=page.getByRole('dialog',{name:'New task',exact:true});
      await dialog.getByLabel('Priority',{exact:true}).selectOption(priority);await button('Add task',dialog).click();
      await expect(button(title)).toBeVisible();
      return f.db.prepare("SELECT id FROM tasks WHERE owner_id='maya' AND title=?").get(title).id;
    };
    const complete=async(title,priority)=>{const taskId=await add(title,priority);await button('Complete '+title).click();await expect.poll(async()=>(await read(`tasks/${taskId}/reaction`)).state).toBe('FINISHED');return {taskId,...await read(`tasks/${taskId}/reaction`)};};
    const first=await complete('Send collection preview','high');expect(first.receipt.effect).toBe('CONFIRMED');
    expect(await read('tasks/'+first.receipt.value.id)).toMatchObject({title:'Follow up',projectId:f.metadata.projectId,status:'open'});
    const event=f.db.prepare("SELECT pins FROM task_events WHERE source_task_id=? AND hook_id='TaskCompleted'").get(first.taskId);
    const saved=await read(`extensions/${id}/revisions/${current.review.revisionId}`);
    expect(JSON.parse(event.pins).artifactDigest).toBe(saved.pins.artifactDigest);
    const outcome=page.getByRole('region',{name:'Customization outcome',exact:true});
    await button('Open task: Follow up',outcome).click();await expect(page.getByLabel('Task title',{exact:true})).toHaveValue('Follow up');
    await page.screenshot({path:'build/core-040/screens/saved-follow-up.png'});await button('Close task details').click();
    const found=await complete('Send collection notes','high');expect(found.receipt).toBeNull();expect(found.outcome.result.status).toBe('NO_OP');
    // Finish the Normal-priority follow-up, then prove a Normal completion skips even with no open match.
    await button('Complete Follow up').click();await expect.poll(async()=>(await read(`tasks/${first.receipt.value.id}/reaction`)).state).toBe('FINISHED');
    const skipped=await complete('Gather ordinary references','normal');expect(skipped.receipt).toBeNull();
    expect(skipped.outcome.trace.filter(e=>e.event==='CALL_DISPATCHED').map(e=>e.capability)).toEqual(['tasks.get']);
    expect(skipped.outcome.trace.some(e=>e.event==='STEP_SKIPPED'&&e.step==='match')).toBe(true);
    expect(f.requests.length).toBe(callCount);
    await navigate('Customizations');await button('Open',page.getByRole('article',{name:'Untitled customization',exact:true})).click();
    await button('See proposed change',ui).first().click();await expect(ui.locator('.rs-rule-summary')).toContainText('High priority');
    expect((await state()).selection.revision.id).toBe(current.review.revisionId);expect(f.requests.length).toBe(callCount);expect(errors).toEqual([]);
  } finally {await f.close();}
});
