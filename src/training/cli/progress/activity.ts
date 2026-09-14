import type { ViewerData } from '../../../viewer/index.js';
import type { Observation } from '../../contracts/execution.js';
import type { EvaluationMeasurement } from '../../contracts/evaluation.js';
import type { TrialEvent } from '../../experiments/trials/index.js';

/** Project trusted persisted events to numbers and fixed status labels only. */
export function createActivityTracker() {
  let activity: ViewerData['activity'];
  const observedCalls = new Set<string>();
  return {
    snapshot: () => activity === undefined ? undefined : structuredClone(activity),
    observe(payload: {trialId:string;caseId:string;phase:'train'|'validation'|'test';event:TrialEvent}) {
      if (activity?.trialId !== payload.trialId) {
        observedCalls.clear();
        activity = {trialId:payload.trialId,caseId:payload.caseId,
          phase:payload.phase,status:'Preparing',toolCalls:0,judgeCalls:0,measurements:[]};
      }
      const event = payload.event;
      if (event.type === 'observation') {
        activity!.status = 'Agent working';
        const observation = event.payload as Observation;
        if ((observation.type === 'tool.dispatch' || observation.type === 'tool.complete')
            && typeof observation.callId === 'string' && observation.callId.length > 0) {
          observedCalls.add(observation.callId);
          activity!.toolCalls = observedCalls.size;
        }
      } else if (event.type === 'judge.attempt') {
        activity!.status = 'Evaluating'; activity!.judgeCalls++;
      } else if (event.type === 'evaluation.measurement') {
        activity!.status = 'Measuring';
        const value = event.payload as EvaluationMeasurement;
        const measurement = {stageId:value.stageId,criterionId:value.criterionId,kind:value.kind,status:value.status,score:value.score,
          ...(value.weight === undefined ? {} : {weight:value.weight}),
          ...(value.weightedContribution === undefined ? {} : {weightedContribution:value.weightedContribution})};
        const measurements = activity!.measurements.filter(row => row.stageId !== value.stageId
          || row.criterionId !== value.criterionId || row.kind !== value.kind);
        activity!.measurements = [...measurements,measurement].slice(-1000);
      } else if (event.type === 'trial.completed') activity!.status = 'Trial complete';
      else if (event.type === 'turn.native-result') activity!.status = 'Agent turn complete';
    },
  };
}
