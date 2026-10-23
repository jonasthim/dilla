import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button } from '@dilla/ui';
import { arr, decode, encode } from '@dilla/client-core';
import { useCore } from '../../core/context.tsx';
import { useSlice } from '../../core/use-slice.ts';
import { t } from '../../strings/index.ts';
import { StepUpDialog } from '../settings/StepUpDialog.tsx';

type Config = { enabled: boolean; rate: string; duplicate: string; mention: string; timeout: number; exempt: string[] };
type Row = { deliveryId: string; requestId: string; communityId: string; operation: number; status: number; revision: string | null; data: Uint8Array };
type SaveRetry = { requestId: string; revision: string; document: Uint8Array; stepUp: string };
const id = (): string => [...crypto.getRandomValues(new Uint8Array(16))].map(x => x.toString(16).padStart(2, '0')).join('');
const defaults: Config = { enabled: false, rate: 'log', duplicate: 'log', mention: 'log', timeout: 600_000, exempt: [] };
const decodeConfig = (raw: Uint8Array): Config => {
  const a = arr(decode(raw), 7); if (a[0] !== 1n || (a[1] !== 0n && a[1] !== 1n) || typeof a[2] !== 'string'
    || typeof a[3] !== 'string' || typeof a[4] !== 'string' || typeof a[5] !== 'bigint' || !Array.isArray(a[6])) throw new Error('invalid config');
  const actions=['log','remove','warn','timeout'];
  if (![a[2],a[3],a[4]].every(v=>typeof v==='string'&&actions.includes(v))||a[5]<1n||a[5]>2419200000n
    ||a[6].length>256||a[6].some(v=>typeof v!=='string'||!/^[0-9a-f]{32}$/u.test(v))||new Set(a[6] as string[]).size!==a[6].length) throw new Error('invalid config');
  return { enabled: a[1] === 1n, rate: a[2], duplicate: a[3], mention: a[4], timeout: Number(a[5]), exempt: a[6] as string[] };
};

export function AutoModerationSettingsPanel({ communityId, botReady, canManage, canManageMessages, canModerateMembers, capabilities }: {
  communityId: string; botReady: boolean; canManage: boolean; canManageMessages: boolean; canModerateMembers: boolean; capabilities: number;
}): React.JSX.Element {
  const client = useCore(); const base = useId(); const generation = useRef(0);
  const factors = useSlice('factors');
  const [config, setConfig] = useState<Config>(defaults); const [revision, setRevision] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false); const [phase, setPhase] = useState<'idle'|'stepup'|'sending'|'waiting'>('idle');
  const [request, setRequest] = useState<string | null>(null); const [error, setError] = useState<string | null>(null); const [notice, setNotice] = useState<string | null>(null);
  const [requestOp, setRequestOp] = useState<62|63>(62);
  const [exemptText, setExemptText] = useState(''); const [pendingConfig, setPendingConfig] = useState<Config | null>(null);
  const [saveRetry, setSaveRetry] = useState<SaveRetry | null>(null);
  const current = useRef(communityId); current.current = communityId;
  useEffect(() => { generation.current++; setConfig(defaults); setRevision(null); setLoaded(false); setPhase('idle'); setRequest(null); setError(null); setNotice(null); setPendingConfig(null); setSaveRetry(null); }, [communityId]);
  const read = useCallback(async (): Promise<void> => {
    if (!botReady || !canManage) return;
    const rid=id(), g=++generation.current; setError(null); setNotice(null); setRequest(rid); setRequestOp(62); setPhase('sending');
    try { const result = await client.call({m:'humanInteractionRequest',communityId,channelId:null,requestId:rid,operation:62,args:[],revision:null}) as {upload:string};
      if (g !== generation.current || current.current !== communityId) return;
      if (result.upload === 'rejected') throw new Error('upload'); setPhase('waiting');
    } catch { if(g===generation.current) { setPhase('idle'); setError(t('admin.bot.automod.loadError')); } }
  },[botReady,canManage,client,communityId]);
  useEffect(() => {
    if (phase !== 'waiting' || request === null || requestOp !== 62) return; const g=generation.current; let canceled=false; let timer:number|undefined;
    const poll=async ():Promise<void> => { try {
      const page=await client.call({m:'readBotInteractionResponses',communityId,operations:[62]}) as {responses:Row[];through:string|null;blocked:boolean};
      if(canceled||g!==generation.current||current.current!==communityId)return;
      const row=page.responses.find(r=>r.requestId===request&&r.communityId===communityId&&r.operation===62);
      if(row!==undefined&&(page.through===null||BigInt(page.through)<BigInt(row.deliveryId))){timer=window.setTimeout(()=>void poll(),1000);return;}
      if(page.through) await client.call({m:'ackBotInteractionResponses',communityId,through:page.through});
      if(canceled||g!==generation.current||current.current!==communityId)return;
      if(row){ if(row.status===0){ const x=decodeConfig(row.data); setConfig(x); setExemptText(x.exempt.join('\n')); setRevision(row.revision); setLoaded(true); setPhase('idle'); setNotice(t('admin.bot.automod.loaded')); }
        else {setPhase('idle');setError(t('admin.bot.automod.readDenied'));} }
      else timer=window.setTimeout(()=>void poll(),1000);
    } catch { if(!canceled){setPhase('idle');setError(t('admin.bot.automod.readError'));} } };
    void poll(); return ()=>{canceled=true;if(timer!==undefined)window.clearTimeout(timer);};
  },[client,communityId,phase,request,requestOp]);
  const beginSave=():void=>{
    if(!loaded||revision===null||!botReady||!canManage)return;
    const exemptions=exemptText.split(/[\s,]+/u).filter(Boolean);
    if(exemptions.length>256||exemptions.some(v=>!/^[0-9a-f]{32}$/u.test(v))||new Set(exemptions).size!==exemptions.length){setError(t('admin.bot.automod.invalidExemptions'));return;}
    if(!Number.isSafeInteger(config.timeout)||config.timeout<1||config.timeout>2419200000){setError(t('admin.bot.automod.prepareError'));return;}
    try { const raw=encode([1n,config.enabled?1n:0n,config.rate,config.duplicate,config.mention,BigInt(config.timeout),exemptions]);
      if(raw.length>2400)throw new Error('oversize'); setPendingConfig({...config,exempt:exemptions}); setPhase('stepup'); setError(null);
    } catch {setError(t('admin.bot.automod.prepareError'));}
  };
  const dispatchSave=(retry:SaveRetry):void=>{
    setRequest(retry.requestId);setRequestOp(63);setPhase('sending');setNotice(null);setError(null);
    void client.call({m:'humanInteractionRequest',communityId,channelId:null,requestId:retry.requestId,operation:63,args:['',retry.document],revision:retry.revision,stepUp:retry.stepUp}).then(result=>{
      if(current.current!==communityId)return; const status=(result as {upload:string}).upload;
      if(status==='accepted'||status==='pending'||status==='unknown'){
        setPhase('waiting');setNotice(t(status==='accepted'?'admin.bot.automod.waiting':'admin.bot.automod.uncertain'));
      } else {setPhase('idle');setError(t('admin.bot.automod.saveError'));}
    }).catch(()=>{if(current.current===communityId){setPhase('idle');setError(t('admin.bot.automod.saveError'));}});
  };
  const save=(stepUp:string):void=>{
    const doc=pendingConfig; if(doc===null||revision===null)return;
    try { const raw=encode([1n,doc.enabled?1n:0n,doc.rate,doc.duplicate,doc.mention,BigInt(doc.timeout),doc.exempt]); if(raw.length>2400)throw new Error('size');
      const retry={requestId:id(),revision,document:raw,stepUp};setSaveRetry(retry);dispatchSave(retry);
    }catch{setPhase('idle');setError(t('admin.bot.automod.prepareError'));}
  };
  useEffect(()=>{if(phase!=='waiting'||request===null||requestOp!==63)return;const g=generation.current;let canceled=false;let timer:number|undefined;
    const poll=async():Promise<void>=>{try{const page=await client.call({m:'readBotInteractionResponses',communityId,operations:[63]}) as {responses:Row[];through:string|null};
      if(canceled||g!==generation.current||current.current!==communityId)return;
      const row=page.responses.find(r=>r.requestId===request&&r.communityId===communityId&&r.operation===63);
      if(row!==undefined&&(page.through===null||BigInt(page.through)<BigInt(row.deliveryId))){timer=window.setTimeout(()=>void poll(),1000);return;}
      if(page.through) await client.call({m:'ackBotInteractionResponses',communityId,through:page.through});
      if(canceled||g!==generation.current||current.current!==communityId)return;
      if(row){setPhase('idle');if(row.status===0){setRevision(row.revision);setLoaded(false);setNotice(t('admin.bot.automod.saved'));void read();}
        else if(row.status===4){setRevision(row.revision);setLoaded(false);setNotice(t('admin.bot.automod.conflictCurrent',{revision:row.revision??'unknown'}));setError(t('admin.bot.automod.conflict'));}
        else setError(t('admin.bot.automod.saveDenied'));}
      else timer=window.setTimeout(()=>void poll(),1000);
    }catch{if(!canceled){setPhase('idle');setError(t('admin.bot.automod.readError'));}}};void poll();return()=>{canceled=true;if(timer!==undefined)window.clearTimeout(timer);};
  },[client,communityId,phase,request,requestOp,read]);
  const busy=phase==='sending'||phase==='waiting';
  const actionDisabled=(value:string):boolean=>value==='remove'?(!canManageMessages||(capabilities&(1<<5))===0)
    :(value==='warn'||value==='timeout')&&(!canModerateMembers||(capabilities&(1<<4))===0);
  const action=(key:'rate'|'duplicate'|'mention',label:string)=> <label>{label}<select value={config[key]} disabled={!canManage||!loaded} onChange={e=>setConfig({...config,[key]:e.target.value})}>
    {['log','remove','warn','timeout'].map(v=><option key={v} value={v} disabled={actionDisabled(v)}>
      {t(`admin.bot.automod.action.${v}` as 'admin.bot.automod.action.log'|'admin.bot.automod.action.remove'|'admin.bot.automod.action.warn'|'admin.bot.automod.action.timeout')}</option>)}</select></label>;
  return <section aria-labelledby={`${base}-title`}><h3 id={`${base}-title`}>{t('admin.bot.automod.title')}</h3><p>{t('admin.bot.automod.help')}</p>
    <p>{t('admin.bot.automod.defaults')}</p><p>{t('admin.bot.automod.capabilityHelp')}</p>{!botReady?<p>{t('admin.bot.automod.requiresBot')}</p>:null}
    {!canManage?<p>{t('admin.bot.automod.requiresManager')}</p>:null}
    <Button aria-disabled={!botReady||!canManage||busy||undefined} onClick={()=>void read()}>{busy?t('admin.bot.automod.waiting'):t('admin.bot.automod.load')}</Button>
    {loaded?<fieldset disabled={!canManage}><label><input type="checkbox" checked={config.enabled} onChange={e=>setConfig({...config,enabled:e.target.checked})}/>{t('admin.bot.automod.enabled')}</label>
      {action('rate',t('admin.bot.automod.rate'))}{action('duplicate',t('admin.bot.automod.duplicate'))}{action('mention',t('admin.bot.automod.mention'))}
      <label>{t('admin.bot.automod.timeout')}<input type="number" min={1} max={2419200000} step={1000} value={config.timeout} onChange={e=>setConfig({...config,timeout:Number(e.target.value)})}/></label>
      <label>{t('admin.bot.automod.exemptions')}<textarea value={exemptText} onChange={e=>setExemptText(e.target.value)}/></label></fieldset>:null}
    {loaded?<Button aria-disabled={!botReady||!canManage||busy||factors===undefined||undefined} onClick={beginSave}>{t('admin.bot.automod.save')}</Button>:null}
    {requestOp===63&&phase==='waiting'&&saveRetry!==null?<Button onClick={()=>dispatchSave(saveRetry)}>{t('admin.bot.automod.retry')}</Button>:null}
    {notice?<p role="status">{notice}</p>:null}{error?<p role="alert">{error}</p>:null}
    <StepUpDialog open={phase==='stepup'} hasPassword={factors?.hasPassword ?? true} notice={null} onToken={token=>{setPhase('idle');save(token);}} onClose={()=>setPhase('idle')}/>
  </section>;
}
