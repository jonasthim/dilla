import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fromHex, toHex } from '../hex.ts';
import * as bot from './protocol.ts';

type Vectors = { cases: { name:string;kind:string;hex:string;body?:string;preimage_hex?:string;context?:Context }[];
  rejects:{ name:string;kind:string;hex?:string;body?:string;context?:Context }[] };
type Context = {community:string;group?:string;actor_user?:string;actor_device?:string;now:string};
const vectors=JSON.parse(readFileSync(new URL('../../../../protocol/vectors/bot.json',import.meta.url),'utf8')) as Vectors;
const ctx=(c:Context)=>({community:fromHex(c.community),group:c.group?fromHex(c.group):undefined,now:BigInt(c.now)});
function decode(kind:string,hex:string,body?:string):any {
 switch(kind){
  case 'request': return body!==undefined?bot.decodeBotRequest(body):bot.decodeBotRequest('dilla.bot/1:'+btoa(String.fromCharCode(...fromHex(hex))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/u,''));
  case 'response': return bot.decodeBotResponse(body ?? 'dilla.bot/1:'+btoa(String.fromCharCode(...fromHex(hex))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/u,''));
  case 'removal': return bot.decodeRemovalProof(fromHex(hex)); case 'event': return bot.decodeDurableEvent(fromHex(hex));
  case 'receipt': return bot.decodeSendReceipt(fromHex(hex)); case 'helper_request': return bot.decodeHelperRequest(fromHex(hex));
  case 'helper_response': return bot.decodeHelperResponse(fromHex(hex)); default: throw new Error('unknown kind');
 }
}
function encode(kind:string,x:any):Uint8Array|string {
 switch(kind){case 'request':return bot.encodeBotRequest(x);case 'response':return bot.encodeBotResponse(x);case 'removal':return bot.encodeRemovalProof(x);
  case 'event':return bot.encodeDurableEvent(x);case 'receipt':return bot.encodeSendReceipt(x);case 'helper_request':return bot.encodeHelperRequest(x);case 'helper_response':return bot.encodeHelperResponse(x);default:throw new Error('unknown kind');}
}
function checkContext(kind:string,x:any,c:Context):void {
 const q=ctx(c);
 if(kind==='request')bot.validateBotContext(x,q);else if(kind==='response')bot.validateBotResponseContext(x,q.community);
 else if(kind==='removal')bot.validateRemovalContext(x,q);else if(kind==='event')bot.validateEventContext(x,q.community);
 else if(kind==='receipt')bot.validateReceiptContext(x,q.community,q.group!);
}

describe('shared bot protocol vectors',()=>{
 it('roundtrips every valid canonical encoding and checks contexts',()=>{
  expect(vectors.cases.length).toBeGreaterThanOrEqual(37);
  const kinds=new Set(vectors.cases.map(c=>c.kind));
  expect([...kinds].sort()).toEqual(['event','helper_request','helper_response','receipt','removal','request','response']);
  for(const c of vectors.cases){
   const x=decode(c.kind,c.hex,c.body);const out=encode(c.kind,x);
   expect(typeof out==='string'?toHex(fromHex(c.hex)):toHex(out),c.name).toBe(c.hex);
   if(c.body!==undefined&&typeof out==='string')expect(out,c.name).toBe(c.body);
   if(c.context)checkContext(c.kind,x,c.context);
   if(c.preimage_hex)expect(toHex(bot.removalPreimage(x)),c.name).toBe(c.preimage_hex);
  }
 });
 it('refuses every structural and context reject vector',()=>{
  for(const c of vectors.rejects){
   const run=()=>{
    if(c.kind==='helper_request'&&c.name.includes('length'))bot.parseHelperFrame(fromHex(c.hex!));
    else {
     const x=decode(c.kind,c.hex??'',c.body);
     if(c.context)checkContext(c.kind,x,c.context);
    }
   };
   expect(run,c.name).toThrow(bot.BotError);
  }
 });
});
