import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { blindOrder } from './benchmark.mjs';
const [reportPath,outPath,seedText='42'] = process.argv.slice(2);
if(!reportPath||!outPath)throw Error('Usage: node listen.mjs output/report.json blind-directory [seed]');
const report=JSON.parse(readFileSync(reportPath)),out=resolve(outPath),base=dirname(resolve(reportPath)),seed=Number(seedText);
if(!Number.isSafeInteger(seed))throw Error('Seed must be an integer');
mkdirSync(out,{recursive:true});const key=[],items=[];
for(const [index,clip] of [...new Set(report.results.map(r=>r.clip))].entries()) {
  const rows=report.results.filter(r=>r.clip===clip);
  for(const [sample,{engine}] of blindOrder(rows.map(r=>r.engine),seed+index).entries()) {
    const row=rows.find(r=>r.engine===engine),code=`c${index}-s${sample}`,file=`${code}.wav`;
    if(!row.file||resolve(base,row.file).startsWith(base+'/')===false)throw Error('Unsafe output path');
    copyFileSync(resolve(base,row.file),resolve(out,file));key.push({code,clip,engine});items.push({code,file,label:`Clip ${index+1}, sample ${sample+1}`});
  }
}
// Keep this outside the blind page's directory. Listeners receive only the directory itself.
writeFileSync(out+'-key.json',JSON.stringify({seed,key},null,2)+'\n');
writeFileSync(resolve(out,'index.html'),`<!doctype html><html lang="en"><meta charset="utf-8"><title>Blind listening</title><main><h1>Blind listening</h1><p>Rate each sample independently. 1 = very poor, 5 = excellent. Count missing words using the supplied transcript, especially word beginnings.</p><label>Listener code <input id="listener" required></label><form id="ratings"></form><button id="save">Save ratings locally</button><script>
const items=${JSON.stringify(items)};const form=document.querySelector('#ratings');
for(const item of items){const section=document.createElement('fieldset');const title=document.createElement('legend');title.textContent=item.label;section.append(title);const audio=document.createElement('audio');audio.controls=true;audio.src=item.file;section.append(audio);for(const metric of ['naturalness','reduction','overall','missingWords']){const label=document.createElement('label');label.textContent=' '+metric+' ';const input=document.createElement('input');input.type='number';input.min=metric==='missingWords'?'0':'1';if(metric!=='missingWords')input.max='5';input.step='1';input.required=true;input.name=item.code+':'+metric;label.append(input);section.append(label);}form.append(section);}
document.querySelector('#save').onclick=()=>{if(!form.reportValidity()||!document.querySelector('#listener').reportValidity())return;const listener=document.querySelector('#listener').value;const data=items.map(item=>Object.fromEntries([['listener',listener],['code',item.code],...['naturalness','reduction','overall','missingWords'].map(k=>[k,Number(form.elements.namedItem(item.code+':'+k).value)])]));const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='ratings.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
</script></main></html>`);
console.log(`Blind page: ${out}/index.html; keep ${out}-key.json from listeners. Use a different seed for each listener.`);
