// Synthetic names and dates; behavior and four case categories follow the verified saved rule.
export const facts = {
 title: 'Give new tasks a due date',
 rule: 'When a new task is added without a due date, give it a due date seven days after it was added.',
 conditions: ['Applies in every project, regardless of title, tags or priority.', 'Only acts if the task still has no due date when its details are read.'],
 unchanged: 'Keep an existing due date. Leave the title, project and other task details unchanged. Tasks that already existed are not updated.',
 sample: {title:'Prepare launch notes',project:'Launch',added:'Added 9 Nov, 09:00 UTC',due:'16 Nov, 09:00 UTC'},
 timing: 'Seven days means exactly 168 hours from when the task was added—not seven working days. Across a clock change, the local hour may shift.',
 checkSummary: 'In the simulation, two tasks received a due date, one kept its date, and one stayed unchanged when its details were unavailable—as intended.',
 cases: [
  {name:'New task with no due date',outcome:'Due date added as intended',expected:'Set the due date to seven days after the task was added.',observed:'Added 9 Nov at 09:00 UTC → due 16 Nov at 09:00 UTC. Only the due date changed.',explanation:'The task had no due date when read.'},
  {name:'New task in another project',outcome:'Due date added as intended',expected:'Use the same rule in another project, even across a year boundary.',observed:'A task added 25 Dec at 00:00 UTC → due 1 Jan at 00:00 UTC.',explanation:'This behavior is not limited to the Launch project.'},
  {name:'Task already has a due date',outcome:'Existing date kept as intended',expected:'Leave its due date unchanged.',observed:'No update was made; its existing date stayed the same.',explanation:'An existing date takes precedence over this customization.'},
  {name:'Task details temporarily unavailable',outcome:'No change when details were unavailable—as intended',expected:'Make no change if the task details cannot be read.',observed:'The example deliberately made reading fail. No update was attempted and no task was changed.',explanation:'This problem was deliberately simulated. The simulation finished: the task stayed unchanged, as intended.'}
 ],
 unchecked: 'These four examples do not cover a missing task, denied access, a rejected update, or an update whose result cannot be confirmed. They do not show whether a fixed 168 hours fits your needs around clock changes.',
 onExplanation: 'From now on, new tasks with no due date will receive one exactly 168 hours after they were added. Tasks in every project are included.',
 clarification: 'Do you mean every project, keeping any due date already set, and exactly 168 hours after the task was added? This includes weekends; it is not seven working days.',
 exceptions: 'A task that already has a due date keeps it. When task details were unavailable in the simulation, no change was intended or made. Existing tasks are not updated.',
 unavailable: 'The example deliberately made task details temporarily unavailable. No update was attempted and no task changed, as expected. That simulation finished; it is not an unfinished simulation or a wrong result.'
};
