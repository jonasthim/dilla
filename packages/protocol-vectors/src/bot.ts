import { encode } from './cbor.ts';
import { hex } from './bytes.ts';

const id = (n: number) => new Uint8Array(16).fill(n);
const comm = id(0x22), group = id(0x33), now = '100';
const context = { community: hex(comm), now };
const app = (op:number,args:unknown[],channel:boolean,mutation:boolean,name:string) => {
  const val=[1,id(1+op%200),comm,channel?id(0x44):null,op,mutation?120n:null,mutation?120n:null,args];
  const raw=encode(val as never); let bin=''; for(const b of raw)bin+=String.fromCharCode(b);
  const body='dilla.bot/1:'+btoa(bin).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/u,'');
  return {name,kind:'request',hex:hex(raw),body,context};
};
const cbor = (v:unknown) => hex(encode(v as never));
export function botVectors() {
 const inputs: Array<[number,unknown[],boolean,boolean,string]> = [
  [0,[],false,false,'overview.get'],[1,[2n],false,false,'settings.get'],[2,[2n,encode([1n,'x'])],false,true,'settings.put'],
  [10,[],true,false,'music.state'],[11,['search'],true,false,'music.search'],[12,['enqueue'],true,true,'music.enqueue'],
  [13,[],true,true,'music.pause'],[14,[],true,true,'music.resume'],[15,[],true,true,'music.skip'],[16,[],true,true,'music.stop'],
  [17,[18446744073709551615n],true,true,'music.seek uint64'],[18,[80n],true,true,'music.volume'],[19,[],true,true,'music.shuffle'],
  [20,[2n],true,true,'music.repeat'],[21,[id(0x55)],true,true,'music.remove'],[22,[id(0x55),null],true,true,'music.move'],[23,[],true,true,'music.clear'],
  [30,['hello'],false,false,'welcome.preview'],[40,[0n],false,false,'roles.list'],[50,[0n],false,false,'announcements.list'],
  [51,[null,encode([1n])],false,true,'announcements.put'],[52,[id(0x66)],false,true,'announcements.delete'],
  [60,[0n],false,false,'moderation.cases'],[61,[id(0x77),'reason','excerpt'],false,true,'moderation.evidence'],
 ];
 const cases:any[]=inputs.map(([op,a,ch,mu,n])=>app(op,a,ch,mu,n));
 const response=[1n,id(2),comm,0n,null,new Uint8Array()];
 cases.push({name:'response ok',kind:'response',hex:cbor(response),body:bodyOf(response),context});
 const proof=[1n,id(3),id(4),id(5),comm,group,7n,120n];
 const pre=Uint8Array.from([...new TextEncoder().encode('dilla moderation removal v1'),...encode(proof as never)]);
 cases.push({name:'signed moderation removal proof',kind:'removal',hex:cbor(proof),preimage_hex:hex(pre),context:{...context,group:hex(group),actor_user:hex(id(4)),actor_device:hex(id(5))}});
 const eventData:any[]=[
  [id(1),id(2)],[id(1),id(2)],[id(1),3n,7n],[0n,id(2),7n],[id(2),1n,7n],
  [id(1),id(2),id(3),id(4),null,group,9n,4n,null],[id(1),7n,1n],
 ];
 eventData.forEach((d,i)=>{const v=[1n,id(0x80+i),BigInt(i+1),comm,1700000000n,BigInt(i+1),d];cases.push({name:`event kind ${i+1}`,kind:'event',hex:cbor(v),context});});
 for(const [name,status,seq,epoch] of [['pending',0n,null,null],['accepted',1n,8n,4n]] as const){
  const v=[1n,id(9),comm,group,new Uint8Array(32).fill(0x88),status,seq,epoch];cases.push({name:`send receipt ${name}`,kind:'receipt',hex:cbor(v),context:{...context,group:hex(group)}});
 }
 for(const [kind,name,v] of [
  ['helper_request','helper request',[1n,id(10),1n,encode([])]],['helper_response','helper response',[1n,id(10),0n,encode([])]],
 ] as const)cases.push({name,kind,hex:cbor(v)});
 const rejects:any[]=[];
 const rej=(name:string,kind:string,v:unknown,extra:any={})=>rejects.push({name,kind,hex:cbor(v),...extra});
 const base=[1n,id(1),comm,null,0n,null,null,[]];
 rej('application wrong version','request',[2n,...base.slice(1)]);
 rej('application wrong shape','request',[1n,id(1)]);
 rej('identifier wrong type','request',[1n,1n,comm,null,0n,null,null,[]]);
 rej('identifier wrong length','request',[1n,new Uint8Array(15).fill(1),comm,null,0n,null,null,[]]);
 rej('identifier zero','request',[1n,id(0),comm,null,0n,null,null,[]]);
 rej('unsupported application operation','request',[1n,id(1),comm,null,999n,null,null,[]]);
 rej('missing mutation revision','request',[1n,id(1),comm,null,2n,null,120n,[0n,encode([1n])]]);
 rej('missing required channel','request',[1n,id(1),comm,null,10n,null,null,[]]);
 rej('wrong argument type','request',[1n,id(1),comm,null,1n,null,null,['bad']]);
 rej('wrong argument count','request',[1n,id(1),comm,null,0n,null,null,[1n]]);
 rej('query over UTF8 byte limit','request',[1n,id(1),comm,id(0x44),11n,null,null,['é'.repeat(101)]]);
 rej('cross community context','request',base,{body:bodyOf(base),context:{community:hex(id(0x23)),now}});
 const mut=[1n,id(1),comm,null,2n,100n,131n,[0n,encode([1n])]];
 rej('expired mutation context','request',mut,{body:bodyOf(mut),context:{community:hex(comm),now}});
 rej('far future mutation context','request',[...mut.slice(0,6),131n+30n,...mut.slice(7)],{context:{community:hex(comm),now}});
 rejects.push({name:'noncanonical base64url',kind:'request',body:'dilla.bot/1:gA=',context});
 rej('nonminimal CBOR','request',null as never); rejects.pop();
 rejects.push({name:'nonminimal CBOR',kind:'request',hex:'9800'});
 rejects.push({name:'trailing CBOR',kind:'request',hex:'8000'});
 rejects.push({name:'CBOR map',kind:'request',hex:'a0'});
 rejects.push({name:'CBOR nesting over limit',kind:'request',hex:'8181818181818181818100'});
 rej('removal sequence zero','removal',[1n,id(3),id(4),id(5),comm,group,0n,120n]);
 rej('event metadata invalid','event',[1n,id(1),1n,comm,1n,3n,[id(2),6n,7n]]);
 rej('timeout event missing expiry','event',[1n,id(1),1n,comm,10n,6n,[id(2),id(3),id(4),id(5),id(6),null,null,1n,null]]);
 rej('receipt pending with sequence','receipt',[1n,id(1),comm,group,new Uint8Array(32),0n,1n,null]);
 rej('receipt accepted without epoch','receipt',[1n,id(1),comm,group,new Uint8Array(32),1n,1n,null]);
 rej('response unsupported status','response',[1n,id(1),comm,10n,null,new Uint8Array()]);
 rej('helper unknown operation','helper_request',[1n,id(1),16n,encode([])]);
 rejects.push({name:'helper malformed length prefix',kind:'helper_request',hex:'0000000580'});
 return {version:1,cases,rejects};
}
function bodyOf(v:unknown):string {const raw=encode(v as never);let s='';for(const b of raw)s+=String.fromCharCode(b);return 'dilla.bot/1:'+btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/u,'');}
