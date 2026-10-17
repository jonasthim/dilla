// Reproducible test runner; uses fresh Playwright browsers, never a user's profile.
import { chromium, firefox, webkit } from 'playwright';
import { createServer } from 'vite';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import os from 'node:os';
import {noiseIdentity} from '../../scripts/noise-identity.mjs';
if(!process.env.PULSE_SERVER&&process.getuid&&existsSync(`/run/user/${process.getuid()}/pulse/native`))process.env.PULSE_SERVER=`unix:/run/user/${process.getuid()}/pulse/native`;
const measuredIdentity=noiseIdentity();
const here=dirname(fileURLToPath(import.meta.url));
const [browserName='chromium',engine='deepfilter',fixture,mode='open']=process.argv.slice(2);
if(!['chromium','firefox','webkit'].includes(browserName)||!['deepfilter','rnnoise','current'].includes(engine))throw Error('Invalid browser or engine');
if(fixture&&browserName!=='chromium')throw Error('File-backed fake capture is Chromium-only');
const server=await createServer({configFile:resolve(here,'vite.config.ts')});await server.listen();
let browser;
try {
  browser=await ({chromium,firefox,webkit}[browserName]).launch({headless:true,...(browserName==='webkit'&&process.env.NOISE_WEBKIT_EXECUTABLE?{executablePath:process.env.NOISE_WEBKIT_EXECUTABLE}:{}),firefoxUserPrefs:{'media.autoplay.default':0,'media.autoplay.block-webaudio':false},args:browserName==='chromium'?['--autoplay-policy=no-user-gesture-required',...(fixture?['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream',`--use-file-for-fake-audio-capture=${resolve(fixture)}`]:[])]:[]});
  const context=await browser.newContext();const page=await context.newPage();
  const unexpected=[],errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error('pageerror',e.message);});page.on('console',m=>{if(m.type()==='error')console.error(m.text());});
  context.on('request',r=>{if(new URL(r.url()).origin!=='http://127.0.0.1:5191')unexpected.push(r.url());});
  await page.goto('http://127.0.0.1:5191');await page.waitForFunction(()=>window.noiseHarness);
  let timer;
  const report=await Promise.race([page.evaluate(async ({engine,fixture,mode})=>window.noiseHarness.run(engine,fixture?10:3,!!fixture,mode),{engine,fixture,mode}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Audio clock/startup timed out; check headless audio backend')),30000);})]).finally(()=>clearTimeout(timer));
  const wav=new Uint8Array(report.wav);delete report.wav;
  Object.assign(report,{...measuredIdentity,browserVersion:browser.version(),cpu:os.cpus()[0]?.model,platform:os.platform(),thirdPartyRequests:unexpected,errors,inputSha256:fixture?createHash('sha256').update(readFileSync(fixture)).digest('hex'):null});
  mkdirSync(resolve(here,'results'),{recursive:true});mkdirSync(resolve(here,'output'),{recursive:true});
  writeFileSync(resolve(here,`output/${browserName}-${engine}.wav`),wav);
  writeFileSync(resolve(here,`results/${browserName}-${engine}${fixture?'-speech-'+mode:''}.json`),JSON.stringify(report,null,2)+'\n');
  if(unexpected.length||errors.length||report.mutedPeak!==0||report.outputPeak<=0)throw Error(`Browser check failed: ${JSON.stringify(report)}`);
  console.log(JSON.stringify(report,null,2));
}catch(error){mkdirSync(resolve(here,'results'),{recursive:true});writeFileSync(resolve(here,`results/${browserName}-${engine}${fixture?'-speech-'+mode:''}.json`),JSON.stringify({kind:'browser-streaming-smoke',browser:browserName,engine,qualified:false,parityClaim:false,error:String(error)},null,2)+'\n');throw error;}finally{await browser?.close();await server.close();}
