import { readFileSync, writeFileSync } from 'node:fs';
import { validateCorpus, summarizeRatings, runtimeVerdict, decodeRatings } from './benchmark.mjs';
const [corpusPath,runtimePath,ratingsPath,keyPath,outputPath] = process.argv.slice(2);
if(!outputPath)throw Error('Usage: node qualify.mjs corpus.json runtime.json ratings.json blind-key.json report.json');
const read=p=>JSON.parse(readFileSync(p));const corpus=read(corpusPath),runtime=runtimeVerdict(read(runtimePath)),key=read(keyPath);
const ratings=decodeRatings(read(ratingsPath),key);
const listening=summarizeRatings(ratings,'deepfilter'),coverage=validateCorpus(corpus);
const report={qualified:false,parityClaim:false,coverage,runtime,listening,reasons:[]};
if(!coverage.complete)report.reasons.push('Corpus coverage or matched references incomplete');
report.reasons.push(...runtime.reasons,...listening.reasons);
// Never flip a production switch from hand-entered scores. Attribution and lifecycle evidence also need review.
report.reasons.push('Release review required: exact model licensing, capture alignment, onset fixtures, lifecycle/reconnect/encryption checks, equally loud speakers and uncertainty.');
writeFileSync(outputPath,JSON.stringify(report,null,2)+'\n');console.log(`Saved ${outputPath}; no production setting changed.`);
