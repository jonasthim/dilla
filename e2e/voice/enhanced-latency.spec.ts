import {expect,test} from './support/peer-browser';
import {watchContexts} from './support/leaks';
import {VoicePeer,WAIT,copy,onboard,openVoiceSettings,closeSettings,joinVoice,noiseOff,heard,heardCount,self} from './support/voice';
import {chromiumMediaArgs,writeFixtures} from '../media/support/fixtures';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {tmpdir,cpus} from 'node:os';
import {createHash} from 'node:crypto';
// @ts-ignore -- local evaluation utility, never imported by the app
import {measureTrackDelay} from '../../experiments/noise/track-delay.mjs';
// @ts-ignore -- local evaluation utility, never imported by the app
import {processingP99} from '../../experiments/noise/runtime-metrics.mjs';
watchContexts(test);
test.skip(process.env.DILLA_NOISE_MODE!=='evaluation','Requires the explicit evaluation build and prepared speech corpus');
test('the enhanced microphone reaches the encrypted sender within the 80 ms budget under load',async({peerBrowser,playwright,browserName},testInfo)=>{
  test.skip(browserName!=='chromium','Direct outgoing audio-track observation is Chromium-only');
  const seconds=Number(process.env.DILLA_NOISE_SECONDS??8);
  if(!Number.isFinite(seconds)||seconds<8)throw Error('At least eight seconds of speech are required');
  test.setTimeout((seconds+180)*1000);
  const fixture=resolve('../experiments/noise/output/fleurs/en_us-00.wav');
  const args=chromiumMediaArgs(writeFixtures(join(tmpdir(),'dilla-media-fixtures'))).filter(a=>!a.startsWith('--use-file-for-fake-audio-capture='));
  const speechBrowser=await playwright.chromium.launch({headless:true,args:[...args,`--use-file-for-fake-audio-capture=${fixture}`]});
  const peer=peerBrowser.track(await VoicePeer.start()),alice=await peerBrowser.open('alice',{browser:speechBrowser}),bob=await peerBrowser.open('bob');
  try{
    // Observe the existing processor graph; add no audio contexts, buffers or signal routing.
    await alice.page.addInitScript(workletCapture=>{
      const w=window as unknown as {latencyInput?:MediaStreamTrack;MediaStreamTrackProcessor:new(o:{track:MediaStreamTrack;maxBufferSize?:number})=>{readable:ReadableStream<unknown>}};
      const errors:unknown[]=[];Object.assign(window,{latencyErrors:errors});
      const NativeWorker=window.Worker;
      window.Worker=class extends NativeWorker{constructor(url:string|URL,options?:WorkerOptions){super(url,options);this.addEventListener('message',e=>{if(e.data.kind==='error')errors.push(e.data);});this.addEventListener('error',e=>errors.push({message:e.message}));}};
      const NativeCapture=w.MediaStreamTrackProcessor;Object.assign(window,{latencyCapture:NativeCapture});
      w.MediaStreamTrackProcessor=class extends NativeCapture{constructor(o:{track:MediaStreamTrack;maxBufferSize?:number}){super(o);w.latencyInput=o.track;}};
      if(workletCapture)Object.defineProperty(window,'MediaStreamTrackProcessor',{value:undefined,configurable:true});
      const Native=window.AudioWorkletNode;
      window.AudioWorkletNode=class extends Native{
        constructor(ctx:BaseAudioContext,name:string,options?:AudioWorkletNodeOptions){
          super(ctx,name,options);
          if(name!=='dilla-deepfilter-transport')return;
          const events:Record<string,unknown>[]=[];
          Object.assign(window,{latencyEvents:events,latencyContext:ctx});
          this.port.addEventListener('message',e=>{if(e.data.kind==='metrics')events.push(e.data);});
          const audio=ctx as AudioContext,dest=audio.createMediaStreamDestination.bind(audio),source=audio.createMediaStreamSource.bind(audio);
          audio.createMediaStreamDestination=()=>{const node=dest();Object.assign(window,{latencyOutput:node.stream.getAudioTracks()[0]});return node;};
          audio.createMediaStreamSource=stream=>{Object.assign(window,{latencyInput:stream.getAudioTracks()[0]});return source(stream);};
        }
      };
    },process.env.DILLA_NOISE_TRANSPORT==='worklet');
    await peer.setup();await onboard(alice,peer,'alice');await onboard(bob,peer,'bob');await peer.seat(2);
    let dialog=await openVoiceSettings(alice.page);await dialog.getByRole('radio',{name:copy('settings.voice.automatic'),exact:true}).click();await closeSettings(alice.page);
    await noiseOff(bob.page);await joinVoice(alice.page,peer.communityName,peer.voiceName);await joinVoice(bob.page,peer.communityName,peer.voiceName);
    dialog=await openVoiceSettings(alice.page);try{await expect(dialog.getByText(copy('settings.voice.processor',{processor:'DeepFilterNet3'}),{exact:false})).toBeVisible({timeout:WAIT});}catch(error){console.log('LATENCY_STARTUP_ERRORS',await alice.page.evaluate(()=>(window as unknown as {latencyErrors:unknown[]}).latencyErrors));throw error;}finally{await closeSettings(alice.page);}
    const aliceDevice=(await self(alice.page)).device;
    await heard(bob.page,aliceDevice);
    alice.page.on('console',message=>{if(message.text().startsWith('NOISE_RUNTIME '))console.log(message.text());});
    const capture=await alice.page.evaluate(async seconds=>{
      const w=window as unknown as {latencyContext:AudioContext;latencyEvents:Record<string,unknown>[];latencyInput:MediaStreamTrack;latencyOutput:MediaStreamTrack;latencyCapture:new(o:{track:MediaStreamTrack;maxBufferSize:number})=>{readable:ReadableStream<any>}};
      const record=async(reader:ReadableStreamDefaultReader<any>)=>{
        const chunks:Array<{received:number;pcm:Float32Array}>=[];
        while(true){const {value,done}=await reader.read();if(done)break;const received=performance.now(),pcm=new Float32Array(value.numberOfFrames);try{if(value.sampleRate!==48000)throw Error('Expected 48 kHz');value.copyTo(pcm,{planeIndex:0,format:'f32-planar'});chunks.push({received,pcm});}finally{value.close();}}
        return chunks;
      };
      // Serialize after both recording windows and the load phase, never between long-run windows.
      const encode=(chunks:Array<{received:number;pcm:Float32Array}>)=>chunks.map(c=>{const bytes=new Uint8Array(c.pcm.buffer);let binary='';for(const b of bytes)binary+=String.fromCharCode(b);return {received:c.received,pcm:btoa(binary)};});
      const captureWindow=async()=>{
        const readers=[w.latencyInput,w.latencyOutput].map(track=>new w.latencyCapture({track,maxBufferSize:100}).readable.getReader());
        try{const recording=readers.map(record);await new Promise(r=>setTimeout(r,8000));await Promise.all(readers.map(r=>r.cancel()));return await Promise.all(recording);}
        finally{await Promise.all(readers.map(r=>r.cancel().catch(()=>{})));}
      };
      const started=performance.now(),clocks:Array<{received:number;context:number}>=[];
      const clock=setInterval(()=>clocks.push({received:performance.now(),context:w.latencyContext.currentTime*1000}),1000);
      const load=setInterval(()=>{const until=performance.now()+6;while(performance.now()<until)Math.sqrt(Math.random());},16);
      const progress=setInterval(()=>{const last=w.latencyEvents.at(-1);console.info('NOISE_RUNTIME '+JSON.stringify({elapsedSeconds:Math.round((performance.now()-started)/1000),frames:last?.frames,buffers:last?.buffers,underruns:last?.underruns,dropped:last?.dropped}));},60000);
      try{
        const tracks=[await captureWindow()];
        if(seconds>8){await new Promise(r=>setTimeout(r,Math.max(0,seconds*1000-8000-(performance.now()-started))));tracks.push(await captureWindow());}
        const events=w.latencyEvents.slice(),durationSeconds=(performance.now()-started)/1000;
        clearInterval(load);
        return {clocks,tracks:tracks.map(pair=>pair.map(encode)),events,inputSettings:w.latencyInput.getSettings(),durationSeconds};
      }finally{clearInterval(clock);clearInterval(load);clearInterval(progress);}
    },seconds);
    const framesAtEnd=await heardCount(bob.page,aliceDevice);
    await expect.poll(()=>heardCount(bob.page,aliceDevice),{timeout:WAIT}).toBeGreaterThan(framesAtEnd+5);
    const verifiedFramesAfterLoad=(await heardCount(bob.page,aliceDevice))-framesAtEnd;
    const decode=(chunks:Array<{received:number;pcm:string}>)=>chunks.map(c=>{const bytes=Buffer.from(c.pcm,'base64');return {received:c.received,pcm:new Float32Array(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength))};});
    const measurements=capture.tracks.map(tracks=>measureTrackDelay(decode(tracks[0]),decode(tracks[1])));
    const result={addedDelayMs:measurements.every(m=>m.addedDelayMs!==null)?Math.max(...measurements.map(m=>m.addedDelayMs)):null,windows:measurements.flatMap((m,i)=>m.windows.map(w=>({...w,phase:i===0?'start':'end'})))};
    const metrics=capture.events.filter(e=>e.kind==='metrics').at(-1),p99ProcessingMs=processingP99(metrics);
    dialog=await openVoiceSettings(alice.page);const effectiveText=await dialog.innerText();await closeSettings(alice.page);
    const enhancedAtEnd=effectiveText.includes(copy('settings.voice.processor',{processor:'DeepFilterNet3'}));
    const report={...JSON.parse(readFileSync('../packages/web/dist/noise-build.json','utf8')),kind:'integrated-encrypted-call-latency',transport:process.env.DILLA_NOISE_TRANSPORT??'automatic',engine:'deepfilter',browserVersion:speechBrowser.version(),cpu:cpus()[0]?.model,loadedCall:true,durationSeconds:capture.durationSeconds,verifiedFramesAfterLoad,load:'two encrypted peers, 6 ms main-thread work per 16 ms',boundary:'Raw microphone track availability to processed track availability, immediately before encryption; no observer AudioContext or subtracted bypass delay.',inputSha256:createHash('sha256').update(readFileSync(fixture)).digest('hex'),inputSettings:capture.inputSettings,clocks:capture.clocks,events:capture.events,buffers:metrics?.buffers,underruns:metrics?.underruns,dropped:metrics?.dropped,p99ProcessingMs,frameMs:10,effectiveText,...result,enhancedAtEnd,addedDelayMs:enhancedAtEnd?result.addedDelayMs:null,measurementFailure:enhancedAtEnd?null:'Enhanced processing ended; fallback windows cannot establish enhanced-path delay.',qualified:false};
    writeFileSync(`../experiments/noise/results/chromium-call-latency${seconds>=1800?'-30min':''}.json`,JSON.stringify(report,null,2)+'\n');
    if(process.env.DILLA_NOISE_RUN_PREFIX)writeFileSync(`${process.env.DILLA_NOISE_RUN_PREFIX}-${testInfo.repeatEachIndex+1}.json`,JSON.stringify(report,null,2)+'\n');
    console.log(`enhanced encrypted-call delay: ${result.addedDelayMs} ms`);
    expect(effectiveText).toContain(copy('settings.voice.processor',{processor:'DeepFilterNet3'}));
    expect(capture.inputSettings).toMatchObject({sampleRate:48000,channelCount:1,noiseSuppression:false,echoCancellation:true,autoGainControl:true});
    expect(capture.durationSeconds).toBeGreaterThanOrEqual(seconds);
    expect(Number(metrics?.buffers)).toBeGreaterThan(0);
    expect(Number(metrics?.underruns)/Number(metrics?.buffers)).toBeLessThan(.001);expect(Number(metrics?.dropped)).toBe(0);
    expect(p99ProcessingMs).not.toBeNull();expect(p99ProcessingMs).toBeLessThan(8);
    expect(result.addedDelayMs).not.toBeNull();expect(result.addedDelayMs).toBeLessThanOrEqual(80);
  }finally{await peerBrowser.close(bob);await peerBrowser.close(alice);await peer.close();await speechBrowser.close();}
});
