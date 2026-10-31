import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { XhsScheduledClock } from './xhs-scheduled-clock';
import { XhsScheduledRunner } from './xhs-scheduled-runner';
import { latestActiveRefreshRound } from '../feeds/active-refresh-schedule';

describe('scheduled creator clock and runner',()=>{
 it('uses the existing Shanghai slots and observes a committed round once after restart',async()=>{
  for(const [at,label] of [['2026-10-31T01:15:00Z','2026-10-31/09:15'],['2026-10-31T06:00:00Z','2026-10-31/14:00'],['2026-10-31T09:30:00Z','2026-10-31/17:30']]) expect(latestActiveRefreshRound(Date.parse(at),0)?.label).toBe(label);
  const dir=await mkdtemp(path.join(tmpdir(),'xhs-clock-spec-')),file=path.join(dir,'fixture.sqlite');await writeFile(file,'');
  const enqueue=jest.fn(async(_round:string,_intent:string)=>{});let clock=new XhsScheduledClock(()=>file,enqueue);
  await clock.tick(Date.parse('2026-10-31T00:00:00Z'));await clock.tick(Date.parse('2026-10-31T01:15:00Z'));
  clock=new XhsScheduledClock(()=>file,enqueue);await clock.tick(Date.parse('2026-10-31T01:15:30Z'));
  expect(enqueue).toHaveBeenCalledTimes(1);expect(enqueue.mock.calls[0][0]).toBe('2026-10-31/09:15');
 },15000);
 it('does not continue media after an unknown basic result',async()=>{
  const service={scheduleCreatorPhase:jest.fn(async(_input:{round:string;creatorId:string;phase:'basic'|'media';batch?:number})=>({taskId:'basic'})),task:jest.fn(async()=>({state:'unknown'}))};
  const runner=new XhsScheduledRunner({xhsCreator:{findMany:async()=>[{id:'synthetic'}]}},service);
  await expect(runner.run('2026-10-31/09:15')).rejects.toThrow('XHS_SCHEDULE_ROUND_INCOMPLETE');
  expect(service.scheduleCreatorPhase).toHaveBeenCalledTimes(1);expect(service.scheduleCreatorPhase.mock.calls[0][0]).toMatchObject({phase:'basic'});
 });
});
