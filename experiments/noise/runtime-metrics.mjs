/** Conservative p99 upper bound for FrameBridge's half-millisecond bins.
 * The final bin is unbounded; missing/incomplete counters cannot establish headroom. */
export function processingP99(metrics){
 const bins=metrics?.processingHistogram,frames=metrics?.frames;
 if(!Array.isArray(bins)||bins.length!==32||!Number.isInteger(frames)||frames<=0||bins.some(n=>!Number.isInteger(n)||n<0)||bins.reduce((a,b)=>a+b,0)!==frames)return null;
 let count=0;
 for(let i=0;i<bins.length;i++){
  count+=bins[i];
  if(count>=frames*.99)return i===31?null:(i+1)/2;
 }
 return null;
}
