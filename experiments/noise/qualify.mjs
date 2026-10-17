import{writeFileSync}from'node:fs';
import{qualify}from'./qualification.mjs';
const [corpus,runtime,ratings,blindKey,evidence,outputIndex,destination]=process.argv.slice(2);
if(!destination)throw Error('Usage: node qualify.mjs corpus.json runtime.json ratings.json blind-key.json evidence.json output-index.json report.json');
const report=qualify({corpus,runtime,ratings,blindKey,evidence,outputIndex});
writeFileSync(destination,JSON.stringify(report,null,2)+'\n');console.log(`Saved ${destination}; no production setting changed.`);
