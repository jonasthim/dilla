// Explicit local browser regression; no microphone hardware, server calls or audio uploads.
import {chromium} from 'playwright';
import {createServer} from 'vite';
import {resolve} from 'node:path';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import os from 'node:os';
import {noiseIdentity,sha256} from '../../scripts/noise-identity.mjs';
import {processingP99} from './runtime-metrics.mjs';
const fixture=resolve(process.argv[2]??'experiments/noise/output/fleurs/en_us-00.wav');
const destination=resolve(process.argv[3]??'experiments/noise/results/chromium-track-latency.json');
if(!existsSync(fixture))throw Error('Prepare the licensed FLEURS corpus or provide a consented speech WAV');
if(!process.env.PULSE_SERVER&&process.getuid&&existsSync(`/run/user/${process.getuid()}/pulse/native`))process.env.PULSE_SERVER=`unix:/run/user/${process.getuid()}/pulse/native`;
const identity=noiseIdentity(),runs=[],failures=[];
const server=await createServer({configFile:resolve('experiments/noise/vite.config.ts')});await server.listen();
try{
 for(let i=0;i<7;i++){
  const browser=await chromium.launch({headless:true,args:['--autoplay-policy=no-user-gesture-required','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream',`--use-file-for-fake-audio-capture=${fixture}`]});
  try{
   const page=await browser.newPage(),requests=[],errors=[];
   page.on('request',r=>{if(new URL(r.url()).origin!=='http://127.0.0.1:5191')requests.push(r.url());});page.on('pageerror',e=>errors.push(e.message));
   await page.goto('http://127.0.0.1:5191');
   const result=await page.evaluate(async({i,workletCapture})=>{const {measureTracks}=await import('/track-latency.ts');return measureTracks(i===0,i>0&&i%2===0,workletCapture);},{i,workletCapture:process.env.DILLA_NOISE_TRANSPORT==='worklet'});
   const run={...result,browserVersion:browser.version(),thirdPartyRequests:requests,errors};runs.push(run);
   if(requests.length||errors.length)failures.push(`run ${i}: network or browser error`);
   if(run.inputSettings.sampleRate!==48000||run.inputSettings.channelCount!==1||run.inputSettings.noiseSuppression!==false||run.inputSettings.echoCancellation!==true||run.inputSettings.autoGainControl!==true)failures.push(`run ${i}: capture settings did not match`);
   if(i===0){
    const [bypass,delayed]=run.measurements;
    const differences=delayed.windows.map((w,n)=>w.addedDelayMs-bypass.windows[n].addedDelayMs);
    if(bypass.addedDelayMs===null||delayed.addedDelayMs===null||differences.some(d=>Math.abs(d-40)>3))failures.push('Known 40 ms delay did not calibrate within 3 ms');
    console.log(JSON.stringify({run:i,calibrationDifferencesMs:differences}));
   }else{
    const measured=run.measurements[0],metrics=run.events.filter(e=>e.kind==='metrics').at(-1);
    run.p99ProcessingMs=processingP99(metrics);run.frameMs=10;
    if(measured.addedDelayMs===null||measured.addedDelayMs>80)failures.push(`run ${i}: delay exceeds 80 ms or unmeasured`);
    if(run.events.some(e=>e.kind==='fallback'||e.kind==='error'))failures.push(`run ${i}: enhanced processing failed or downgraded`);
    if(!metrics||!(metrics.buffers>0)||metrics.underruns/metrics.buffers>=.001||metrics.dropped>0)failures.push(`run ${i}: underruns or dropped frames`);
    if(run.p99ProcessingMs===null||run.p99ProcessingMs>=8)failures.push(`run ${i}: insufficient p99 processing headroom`);
    console.log(JSON.stringify({run:i,loaded:run.loaded,...measured,metrics}));
   }
  }finally{await browser.close();}
 }
}finally{
 await server.close();
 const result={date:new Date().toISOString(),kind:'outgoing-track-latency',engine:'deepfilter',...identity,inputSha256:sha256(readFileSync(fixture)),cpu:os.cpus()[0]?.model,platform:os.platform(),loadedCall:false,qualified:false,parityClaim:false,passed:failures.length===0&&runs.length===7,failures,runs};
 writeFileSync(destination,JSON.stringify(result,null,2)+'\n');
}
if(failures.length)throw Error(failures.join('; '));
