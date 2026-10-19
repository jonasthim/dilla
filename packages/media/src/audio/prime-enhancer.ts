/** Compile lazy inference paths before live capture. Never retain synthetic stream history. */
export function primeEnhancer(processFrame:(pcm:Float32Array)=>void,reset:()=>void):void {
  const pcm=new Float32Array(480);
  try {
    for(let frame=0;frame<1024;frame++){
      for(let i=0;i<pcm.length;i++){const n=frame*pcm.length+i;pcm[i]=.1*Math.sin(n*.057)+.05*Math.sin(n*.113)+.03*Math.cos(n*.317);}
      processFrame(pcm);
    }
  } finally { pcm.fill(0); reset(); }
}
