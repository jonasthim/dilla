import { useEffect, useRef, useState } from 'react';
import type { NoisePreference, ProcessorStatus } from '@dilla/media';
import type { LocalMicrophoneTest } from '../../call/microphone-test.ts';
import { t } from '../../strings/index.ts';
export function MicrophoneTest({input,noise,disabled,onOpen}:{input:string;noise:NoisePreference;disabled:boolean;onOpen:(open:boolean)=>void}):React.JSX.Element {
  const test = useRef<LocalMicrophoneTest|null>(null);
  const generation = useRef(0);
  const [phase,setPhase] = useState<'closed'|'starting'|'recording'|'ready'|'failed'>('closed');
  const [url,setUrl] = useState<string|null>(null);
  const [status,setStatus] = useState<ProcessorStatus|null>(null);
  useEffect(() => {
    const close = () => { generation.current++; void test.current?.close(); test.current=null; setUrl(null); setStatus(null); setPhase('closed'); onOpen(false); };
    close(); window.addEventListener('pagehide',close);
    return () => { close(); window.removeEventListener('pagehide',close); };
  },[input,noise,disabled,onOpen]);
  const close = () => { generation.current++; void test.current?.close(); test.current=null;setUrl(null);setStatus(null);setPhase('closed');onOpen(false); };
  const start = async () => {
    if(disabled)return;
    const id=++generation.current;setPhase('starting');onOpen(true);
    try {
      const {LocalMicrophoneTest} = await import('../../call/microphone-test.ts');
      if(id!==generation.current)return;
      const capture=test.current=new LocalMicrophoneTest(value=>{if(id===generation.current){setUrl(value);setPhase('ready');}},s=>{if(id===generation.current)setStatus(s);},()=>{if(id===generation.current){setPhase('failed');onOpen(false);}});
      await capture.start(input,noise);
      if(id===generation.current)setPhase(p=>p==='starting'?'recording':p);
    }catch{if(id===generation.current){setPhase('failed');onOpen(false);}}
  };
  return <div>
    <p>{t(disabled?'settings.voice.testCall':'settings.voice.testHelp')}</p>
    {phase==='closed'||phase==='failed'?<button type="button" className="d-btn" disabled={disabled} onClick={()=>{void start();}}>{t('settings.voice.test')}</button>:null}
    {phase==='recording'?<button type="button" className="d-btn" onClick={()=>test.current?.stop()}>{t('settings.voice.testStop')}</button>:null}
    {phase!=='closed'?<button type="button" className="d-btn" onClick={close}>{t('settings.voice.testClose')}</button>:null}
    <p role="status">{phase==='starting'?t('settings.voice.testStarting'):phase==='recording'?t('settings.voice.testRecording'):phase==='failed'?t('settings.voice.testFailed'):null}</p>
    {status?<p>{t('settings.voice.processor',{processor:(status.effective === 'off' || (status.effective === 'browser' && status.browserNoise === 'off')) ? t('settings.voice.processor.off') : status.effective === 'browser' ? t('settings.voice.processor.browser') : status.effective === 'failed' ? t('settings.voice.processor.failed') : status.effective === 'initializing' ? t('settings.voice.processor.initializing') : status.engineName ?? t('settings.voice.lightweight')})}{' '}{status.reason?t(`settings.voice.fallback.${status.reason}`):null}{' '}{status.browserNoise==='on'&&noise==='off'?t('settings.voice.browserStillOn'):null}</p>:null}
    {/* A private microphone preview has no separately available captions. */}
    {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
    {url?<audio controls src={url} aria-label={t('settings.voice.testPlayback')} />:null}
  </div>;
}
