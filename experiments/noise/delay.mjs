/** Normalized waveform correlation on simultaneous raw/processed taps. No wall-clock inference timing. */
export function measureDelay(input,output,rate=48000,maxMs=120){
  const stride=6,limit=Math.min(input.length,output.length)-Math.ceil(maxMs*rate/1000);
  if(limit<rate/2)return {addedDelayMs:null,correlation:null,reason:'Recording too short'};
  let best=-1,bestLag=0;
  // Skip capture startup; use up to two seconds of non-periodic speech.
  const start=Math.min(Math.floor(rate/4),Math.floor(limit/4)),end=Math.min(limit,start+rate*2);
  for(let lag=0;lag<=maxMs*rate/1000;lag+=stride){
    let xy=0,xx=0,yy=0;
    for(let i=start;i<end;i+=stride){const x=input[i],y=output[i+lag];xy+=x*y;xx+=x*x;yy+=y*y;}
    const correlation=xx*yy>1e-12?xy/Math.sqrt(xx*yy):0;
    if(correlation>best){best=correlation;bestLag=lag;}
  }
  return best<.3?{addedDelayMs:null,correlation:best,reason:'Insufficient waveform correlation'}:{addedDelayMs:bestLag/rate*1000,correlation:best,reason:null};
}
