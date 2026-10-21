import { arr, bin, decode, encode, str, u64, type CborInput, type CborValue } from '../cbor/index.ts';

const MAX = (1n << 64n) - 1n;
const enc = new TextEncoder();
const dec = new TextDecoder();
const PREFIX = 'dilla.bot/1:';
const HELPER_MAX = 1_048_576;

export class BotError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'BotError'; }
}
const fail = (code = 'E_BOT_INVALID'): never => { throw new BotError(code); };
function guarded<T>(run: () => T): T {
  try { return run(); } catch (e) { if (e instanceof BotError) throw e; return fail('E_BOT_CBOR'); }
}
const bytes = (v: unknown, n?: number): Uint8Array => {
  if (!(v instanceof Uint8Array) || (n !== undefined && v.length !== n)) fail('E_BOT_SHAPE');
  return v as Uint8Array;
};
const id = (v: unknown): Uint8Array => { const b = bytes(v, 16); if (b.every(x => x === 0)) fail('E_BOT_ID'); return b; };
const uint = (v: unknown, min = 0n, max = MAX): bigint => {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) v = BigInt(v);
  if (typeof v !== 'bigint' || v < min || v > max) fail('E_BOT_RANGE');
  return v as bigint;
};
const nullable = (v: unknown, read: (v: unknown) => unknown) => v === null ? null : read(v);
function text(v: unknown, min: number, max: number, controls = false): string {
  if (typeof v !== 'string') fail('E_BOT_SHAPE');
  const s = v as string; const n = enc.encode(s).length;
  if (n < min || n > max || (controls && /[\u0000-\u001f\u007f]/u.test(s))) fail('E_BOT_RANGE');
  return s;
}
const cborBytes = (v: unknown, min: number, max: number): Uint8Array => {
  const b = bytes(v); if (b.length < min || b.length > max) fail('E_BOT_RANGE');
  const value = decode(b); if (!Array.isArray(value)) fail('E_BOT_SHAPE'); return b;
};
const readId = (v: CborValue) => id(v);
const readOptId = (v: CborValue) => nullable(v, x => readId(x as CborValue)) as Uint8Array | null;
const readOptU = (v: CborValue) => nullable(v, x => u64(x as CborValue)) as bigint | null;
const base64url = (b: Uint8Array) => {
  let s = ''; for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
};
function unbase64url(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(s)) fail('E_BOT_BASE64');
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4);
  let raw: string; try { raw = atob(padded); } catch { return fail('E_BOT_BASE64'); }
  const out = Uint8Array.from(raw, c => c.charCodeAt(0));
  if (base64url(out) !== s) fail('E_BOT_BASE64'); return out;
}
function bodyEncode(value: CborInput, max = 4000): string {
  const b = encode(value); const s = PREFIX + base64url(b);
  if (enc.encode(s).length > max) fail('E_BOT_SIZE'); return s;
}
function bodyDecode(body: string, max = 4000): CborValue {
  if (typeof body !== 'string' || enc.encode(body).length > max || !body.startsWith(PREFIX)) fail('E_BOT_BODY');
  try { return decode(unbase64url(body.slice(PREFIX.length))); } catch (e) { if (e instanceof BotError) throw e; return fail('E_BOT_CBOR'); }
}

export interface BotRequest { requestId: Uint8Array; communityId: Uint8Array; channelId: Uint8Array | null; operation: number; revision: bigint | null; expires: bigint | null; args: CborInput[] }
export interface BotContext { community: Uint8Array; group?: Uint8Array; now: bigint }
const ops: Record<number, { channel: boolean; mutation: boolean; count: number }> = {
  0:{channel:false,mutation:false,count:0},1:{channel:false,mutation:false,count:1},2:{channel:false,mutation:true,count:2},
  10:{channel:true,mutation:false,count:0},11:{channel:true,mutation:false,count:1},12:{channel:true,mutation:true,count:1},
  13:{channel:true,mutation:true,count:0},14:{channel:true,mutation:true,count:0},15:{channel:true,mutation:true,count:0},16:{channel:true,mutation:true,count:0},
  17:{channel:true,mutation:true,count:1},18:{channel:true,mutation:true,count:1},19:{channel:true,mutation:true,count:0},20:{channel:true,mutation:true,count:1},
  21:{channel:true,mutation:true,count:1},22:{channel:true,mutation:true,count:2},23:{channel:true,mutation:true,count:0},
  30:{channel:false,mutation:false,count:1},40:{channel:false,mutation:false,count:1},50:{channel:false,mutation:false,count:1},
  51:{channel:false,mutation:true,count:2},52:{channel:false,mutation:true,count:1},60:{channel:false,mutation:false,count:1},61:{channel:false,mutation:true,count:3},
};
function validateArgs(op: number, a: unknown[]): void {
  const spec = ops[op]; if (!spec) fail('E_BOT_OPERATION'); if (a.length !== spec.count) fail('E_BOT_SHAPE');
  const u = (i:number,min=0n,max=MAX) => { a[i]=uint(a[i],min,max); };
  const t = (i:number,min:number,max:number,ctrl=false) => { a[i]=text(a[i],min,max,ctrl); };
  const ident=(i:number)=>{a[i]=id(a[i]);};
  switch(op) {
    case 1: case 2: u(0,0n,5n); if(op===2) a[1]=cborBytes(a[1],1,2400); break;
    case 11: t(0,1,200,true); break; case 12: t(0,1,2048,true); break;
    case 17: u(0); break; case 18: u(0,0n,100n); break; case 20: u(0,0n,2n); break;
    case 21: case 52: ident(0); break; case 22: ident(0); a[1]=nullable(a[1],id); break;
    case 30: t(0,1,2000); break; case 40: case 50: case 60: u(0); break;
    case 51: a[0]=nullable(a[0],id); a[1]=cborBytes(a[1],1,2200); break;
    case 61: ident(0); t(1,0,1024); t(2,0,512); break;
  }
}
function requestValue(x: BotRequest): CborInput[] {
  id(x.requestId); id(x.communityId); nullable(x.channelId,id); uint(x.operation,0n,MAX);
  if (typeof x.operation !== 'number' || !Number.isInteger(x.operation)) fail('E_BOT_OPERATION');
  const spec=ops[x.operation]; if(!spec) fail('E_BOT_OPERATION');
  if (spec.channel !== (x.channelId !== null)) fail('E_BOT_CHANNEL');
  if (spec.mutation ? x.revision === null || x.expires === null : x.revision !== null || x.expires !== null) fail('E_BOT_CONTEXT');
  if(x.revision!==null)uint(x.revision); if(x.expires!==null)uint(x.expires);
  if (!Array.isArray(x.args)) fail('E_BOT_SHAPE');
  const args=[...x.args]; validateArgs(x.operation,args);
  return [1n,x.requestId,x.communityId,x.channelId,BigInt(x.operation),x.revision,x.expires,args];
}
function readRequest(v: CborValue): BotRequest {
  const a=arr(v,8); if(u64(a[0]!)!==1n)fail('E_BOT_VERSION');
  const op=Number(u64(a[4]!)); if(!Number.isSafeInteger(op))fail('E_BOT_OPERATION');
  const out:BotRequest={requestId:readId(a[1]!),communityId:readId(a[2]!),channelId:readOptId(a[3]!),operation:op,
    revision:readOptU(a[5]!),expires:readOptU(a[6]!),args:arr(a[7]!) as CborInput[]};
  requestValue(out); return out;
}
export function encodeBotRequest(request: BotRequest): string { return guarded(() => bodyEncode(requestValue(request))); }
export function decodeBotRequest(body: string): BotRequest { return guarded(() => readRequest(bodyDecode(body))); }
export function validateBotContext(request: BotRequest, context: BotContext): void {
  if (!equalId(request.communityId, context.community)) fail('E_BOT_COMMUNITY');
  if (request.revision !== null) {
    const now=uint(context.now); if (request.expires === null || request.expires <= now || now > MAX-30n || request.expires > now+30n) fail('E_BOT_EXPIRED');
  }
}
function equalId(a:Uint8Array,b:Uint8Array):boolean { return a.length===b.length && a.every((v,i)=>v===b[i]); }

export interface BotResponse { requestId:Uint8Array; communityId:Uint8Array; status:number; revision:bigint|null; data:Uint8Array }
function responseValue(x:BotResponse):CborInput[] { id(x.requestId);id(x.communityId);uint(x.status,0n,9n); if(!Number.isInteger(x.status))fail('E_BOT_RANGE'); if(x.revision!==null)uint(x.revision); const data=bytes(x.data);if(data.length>2400)fail('E_BOT_RANGE');if(data.length && !Array.isArray(decode(data)))fail('E_BOT_SHAPE');return [1n,x.requestId,x.communityId,BigInt(x.status),x.revision,data]; }
function readResponse(v:CborValue):BotResponse { const a=arr(v,6);if(u64(a[0]!)!==1n)fail('E_BOT_VERSION');const status=Number(u64(a[3]!));const out={requestId:readId(a[1]!),communityId:readId(a[2]!),status,revision:readOptU(a[4]!),data:bytes(a[5]!)};responseValue(out);return out; }
export const encodeBotResponse=(x:BotResponse)=>guarded(()=>bodyEncode(responseValue(x)));
export const decodeBotResponse=(body:string)=>guarded(()=>readResponse(bodyDecode(body)));
export function validateBotResponseContext(x:BotResponse,community:Uint8Array):void { if(!equalId(x.communityId,community))fail('E_BOT_COMMUNITY'); }

export interface RemovalProof { requestId:Uint8Array; actorUser:Uint8Array; actorDevice:Uint8Array; communityId:Uint8Array; groupId:Uint8Array; targetSeq:bigint; expires:bigint }
function removalValue(x:RemovalProof):CborInput[] { id(x.requestId);id(x.actorUser);id(x.actorDevice);id(x.communityId);id(x.groupId);uint(x.targetSeq,1n);uint(x.expires,1n);return [1n,x.requestId,x.actorUser,x.actorDevice,x.communityId,x.groupId,x.targetSeq,x.expires]; }
function readRemoval(v:CborValue):RemovalProof { const a=arr(v,8);if(u64(a[0]!)!==1n)fail('E_BOT_VERSION');const x={requestId:readId(a[1]!),actorUser:readId(a[2]!),actorDevice:readId(a[3]!),communityId:readId(a[4]!),groupId:readId(a[5]!),targetSeq:u64(a[6]!),expires:u64(a[7]!)};removalValue(x);return x; }
export const encodeRemovalProof=(x:RemovalProof)=>guarded(()=>encode(removalValue(x)));
export const decodeRemovalProof=(b:Uint8Array)=>guarded(()=>readRemoval(decode(b)));
export const removalPreimage=(x:RemovalProof)=>{const p=enc.encode('dilla moderation removal v1'),b=encodeRemovalProof(x),o=new Uint8Array(p.length+b.length);o.set(p);o.set(b,p.length);return o;};
export function validateRemovalContext(x:RemovalProof,c:BotContext):void { if(!equalId(x.communityId,c.community)||!equalId(x.groupId,c.group??new Uint8Array()))fail('E_BOT_COMMUNITY');const now=uint(c.now);if(x.expires<=now||now>MAX-30n||x.expires>now+30n)fail('E_BOT_EXPIRED'); }

export interface DurableEvent { eventId:Uint8Array;sequence:bigint;communityId:Uint8Array;timestamp:bigint;kind:number;data:CborInput[] }
function eventData(kind:number,d:unknown[]):void {
 const ident=(i:number)=>{d[i]=id(d[i]);},u=(i:number,min=0n,max=MAX)=>{d[i]=uint(d[i],min,max);};
 const shape:Record<number,number>={1:2,2:2,3:3,4:3,5:3,6:9,7:3}; if(!shape[kind])fail('E_BOT_OPERATION');if(d.length!==shape[kind])fail('E_BOT_SHAPE');
 switch(kind){case 1:case 2:ident(0);ident(1);break;case 3:ident(0);u(1,0n,5n);u(2);break;case 4:u(0,0n,3n);ident(1);u(2);break;case 5:ident(0);u(1,0n,2n);u(2);break;
 case 6:ident(0);ident(1);ident(2);ident(3);d[4]=nullable(d[4],id);d[5]=nullable(d[5],id);d[6]=nullable(d[6],v=>uint(v,1n));u(7,0n,6n);d[8]=nullable(d[8],v=>uint(v,1n));
   if(d[7]===4n){if(d[5]===null||d[6]===null)fail('E_BOT_SHAPE');}else if(d[4]===null||d[5]!==null||d[6]!==null)fail('E_BOT_SHAPE');
   break;
 case 7:ident(0);u(1);u(2,0n,1n);break; }
}
function eventValue(x:DurableEvent):CborInput[]{id(x.eventId);uint(x.sequence,1n);id(x.communityId);uint(x.timestamp);uint(x.kind,1n,7n);if(!Number.isInteger(x.kind))fail('E_BOT_RANGE');if(!Array.isArray(x.data))fail('E_BOT_SHAPE');const d=[...x.data];eventData(x.kind,d);if(x.kind===6){const action=d[7] as bigint,expires=d[8] as bigint|null;if(action===1n&&(expires===null||expires<=x.timestamp))fail('E_BOT_RANGE');if(action===3n&&expires!==null&&expires<=x.timestamp)fail('E_BOT_RANGE');if(action!==1n&&action!==3n&&expires!==null)fail('E_BOT_SHAPE');}return [1n,x.eventId,x.sequence,x.communityId,x.timestamp,BigInt(x.kind),d];}
function readEvent(v:CborValue):DurableEvent{const a=arr(v,7);if(u64(a[0]!)!==1n)fail('E_BOT_VERSION');const kind=Number(u64(a[5]!));const x={eventId:readId(a[1]!),sequence:u64(a[2]!),communityId:readId(a[3]!),timestamp:u64(a[4]!),kind,data:arr(a[6]!) as CborInput[]};eventValue(x);return x;}
export const encodeDurableEvent=(x:DurableEvent)=>guarded(()=>{const b=encode(eventValue(x));if(b.length>4096)fail('E_BOT_SIZE');return b;});
export const decodeDurableEvent=(b:Uint8Array)=>guarded(()=>{if(b.length>4096)fail('E_BOT_SIZE');return readEvent(decode(b));});
export function validateEventContext(x:DurableEvent,community:Uint8Array):void{if(!equalId(x.communityId,community))fail('E_BOT_COMMUNITY');}

export interface SendReceipt { operationId:Uint8Array;communityId:Uint8Array;groupId:Uint8Array;ciphertextSha256:Uint8Array;status:number;sequence:bigint|null;epoch:bigint|null }
function receiptValue(x:SendReceipt):CborInput[]{id(x.operationId);id(x.communityId);id(x.groupId);bytes(x.ciphertextSha256,32);uint(x.status,0n,1n);if(!Number.isInteger(x.status))fail('E_BOT_RANGE');if(x.status===0?(x.sequence!==null||x.epoch!==null):(x.sequence===null||x.epoch===null))fail('E_BOT_SHAPE');if(x.sequence!==null)uint(x.sequence,1n);if(x.epoch!==null)uint(x.epoch);return [1n,x.operationId,x.communityId,x.groupId,x.ciphertextSha256,BigInt(x.status),x.sequence,x.epoch];}
function readReceipt(v:CborValue):SendReceipt{const a=arr(v,8);if(u64(a[0]!)!==1n)fail('E_BOT_VERSION');const x={operationId:readId(a[1]!),communityId:readId(a[2]!),groupId:readId(a[3]!),ciphertextSha256:bytes(a[4]!,32),status:Number(u64(a[5]!)),sequence:readOptU(a[6]!),epoch:readOptU(a[7]!)};receiptValue(x);return x;}
export const encodeSendReceipt=(x:SendReceipt)=>guarded(()=>{const b=encode(receiptValue(x));if(b.length>512)fail('E_BOT_SIZE');return b;});
export const decodeSendReceipt=(b:Uint8Array)=>guarded(()=>{if(b.length>512)fail('E_BOT_SIZE');return readReceipt(decode(b));});
export function validateReceiptContext(x:SendReceipt,community:Uint8Array,group:Uint8Array):void{if(!equalId(x.communityId,community)||!equalId(x.groupId,group))fail('E_BOT_COMMUNITY');}

export interface HelperEnvelope { requestId:Uint8Array;operation:number;payload:Uint8Array }
export interface HelperResponse { requestId:Uint8Array;status:number;payload:Uint8Array }
function helperVal(x:HelperEnvelope|HelperResponse,response:boolean):CborInput[]{id(x.requestId);const op=response?(x as HelperResponse).status:(x as HelperEnvelope).operation;uint(op,response?0n:1n,response?9n:15n);if(!Number.isInteger(op))fail('E_BOT_RANGE');const p=bytes(x.payload);if(!p.length||p.length>1_048_480||!Array.isArray(decode(p)))fail('E_BOT_SHAPE');return [1n,x.requestId,BigInt(op),p];}
function readHelper(v:CborValue,response:boolean):HelperEnvelope|HelperResponse{const a=arr(v,4);if(u64(a[0]!)!==1n)fail('E_BOT_VERSION');const out=response?{requestId:readId(a[1]!),status:Number(u64(a[2]!)),payload:bytes(a[3]!)}:{requestId:readId(a[1]!),operation:Number(u64(a[2]!)),payload:bytes(a[3]!)};helperVal(out,response);return out;}
const helperBody=(v:CborInput[])=>{const b=encode(v);if(b.length>HELPER_MAX)fail('E_BOT_SIZE');return b;};
export const encodeHelperRequest=(x:HelperEnvelope)=>guarded(()=>helperBody(helperVal(x,false)));
export const decodeHelperRequest=(b:Uint8Array)=>guarded(()=>{if(b.length>HELPER_MAX)fail('E_BOT_SIZE');return readHelper(decode(b),false) as HelperEnvelope;});
export const encodeHelperResponse=(x:HelperResponse)=>guarded(()=>helperBody(helperVal(x,true)));
export const decodeHelperResponse=(b:Uint8Array)=>guarded(()=>{if(b.length>HELPER_MAX)fail('E_BOT_SIZE');return readHelper(decode(b),true) as HelperResponse;});
export function frameHelper(b:Uint8Array):Uint8Array {if(b.length<1||b.length>HELPER_MAX)fail('E_BOT_SIZE');const out=new Uint8Array(b.length+4);new DataView(out.buffer).setUint32(0,b.length,false);out.set(b,4);return out;}
export function parseHelperFrame(b:Uint8Array):Uint8Array {if(b.length<4)fail('E_BOT_FRAME');const n=new DataView(b.buffer,b.byteOffset,b.byteLength).getUint32(0,false);if(n<1||n>HELPER_MAX||n!==b.length-4)fail('E_BOT_FRAME');return b.slice(4);}
