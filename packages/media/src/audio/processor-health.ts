/** Three consecutive unhealthy one-second intervals trigger one permanent downgrade. */
export class ProcessorHealth {
  private previous={buffers:0,underruns:0,dropped:0};
  private failures=0;
  observe(now:{buffers:number;underruns:number;dropped:number}):boolean {
    const buffers=now.buffers-this.previous.buffers, underruns=now.underruns-this.previous.underruns, dropped=now.dropped-this.previous.dropped;
    this.previous={...now};
    if(buffers<100){this.failures=0;return false;}
    this.failures=underruns/buffers>=0.001||dropped>0?this.failures+1:0;
    return this.failures>=3;
  }
}
