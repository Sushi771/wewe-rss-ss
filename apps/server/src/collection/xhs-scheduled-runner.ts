/** The clock callback retries observation, never a source request: admission is keyed by round/creator/phase. */
type State = {state:string;failed?:number;remaining?:number;code?:string};
type Service = {scheduleCreatorPhase(input:{round:string;creatorId:string;phase:'basic'|'media';batch?:number}):Promise<{taskId?:string;state?:string;scheduledState?:string}>;task(input:{taskId:string}):Promise<State>;archiveScheduled?(round:string,creatorId:string):Promise<{incomplete:boolean}>};
type Db = {xhsCreator:{findMany(input:unknown):Promise<Array<{id:string}>>}};
export class XhsScheduledRunner {
  constructor(private readonly db:Db,private readonly service:Service,private readonly engagement?:{collectScheduled(round:string,creatorId:string):Promise<{pending:boolean;incomplete:boolean}>}) {}
  async run(round:string) {
    const authors=await this.db.xhsCreator.findMany({where:{enabled:true},select:{id:true},orderBy:{id:'asc'}});
    let pending=false, incomplete=false;
    for(const author of authors){
      try {
      const basic=await this.service.scheduleCreatorPhase({round,creatorId:author.id,phase:'basic'});
      if(basic.state==='deferred'){pending=true;continue;}
      if(!basic.taskId)throw Error('XHS_SCHEDULE_ADMISSION_UNKNOWN');
      const b=await this.service.task({taskId:basic.taskId});
      if(['queued','running'].includes(b.state)){pending=true;continue;}
      const historyPartial=b.state==='partial' && b.code==='XHS_SCHEDULE_HISTORY_REVIEW_REQUIRED' && !b.failed;
      const itemPartial=b.state==='partial' && ['XHS_DETAIL_PARSE_FAILED','XHS_DETAIL_OUTCOME_UNKNOWN'].includes(b.code??'') && !!b.failed && b.remaining===0;
      if(historyPartial||itemPartial)incomplete=true;
      if((b.state!=='completed'&&!historyPartial&&!itemPartial)||(b.failed&&!itemPartial)){incomplete=true;continue;}
      let mediaPending=false;
      for(let batch=0;;batch++) {
        const media=await this.service.scheduleCreatorPhase({round,creatorId:author.id,phase:'media',batch});
        if(media.state==='nothing-to-archive')break;
        if(media.state==='deferred'){pending=true;mediaPending=true;break;}
        if(!media.taskId)throw Error('XHS_SCHEDULE_ADMISSION_UNKNOWN');
        const m=await this.service.task({taskId:media.taskId});
        if(['queued','running'].includes(m.state)){pending=true;mediaPending=true;break;}
        const safePartial=m.state==='partial'&&!m.failed&&!m.remaining&&['XHS_MEDIA_NEEDS_DETAIL_REFRESH','XHS_MEDIA_REVIEW_REQUIRED'].includes(m.code??'');
        if(safePartial){incomplete=true;continue;}
        if(m.state!=='completed'||m.failed||m.remaining){incomplete=true;break;}
      }
      if(!mediaPending && this.engagement){const comments=await this.engagement.collectScheduled(round,author.id);pending ||= comments.pending;incomplete ||= comments.incomplete;}
      if(!mediaPending && this.service.archiveScheduled){const archive=await this.service.archiveScheduled(round,author.id);incomplete ||= archive.incomplete;}
      } catch { incomplete=true; }
    }
    if(pending)throw Error('XHS_SCHEDULE_TASK_PENDING');
    if(incomplete)throw Error('XHS_SCHEDULE_ROUND_INCOMPLETE');
  }
}
