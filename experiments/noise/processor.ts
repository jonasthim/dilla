// The evaluation harness exercises the same implementation that calls and microphone tests use.
import { DillaDeepFilterProcessor } from '../../packages/media/src/audio/deepfilter';
export class ExperimentalDeepFilterProcessor extends DillaDeepFilterProcessor {
  constructor(report:(event:Record<string,unknown>)=>void=()=>{},mode:'open'|'vad'='vad') {
    super({mode,allowed:false,onMetrics:report,onEffective:(effective,reason)=>report({kind:'fallback',effective,reason}),onFailure:reason=>report({kind:'error',reason})});
  }
}
