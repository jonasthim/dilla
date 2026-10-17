import {test} from 'node:test';
import assert from 'node:assert/strict';
import {processingP99} from './runtime-metrics.mjs';
test('requires measured inference headroom, including intermittent slow frames',()=>{
 const processingHistogram=Array(32).fill(0);
 processingHistogram[2]=990;processingHistogram[20]=10;
 assert.equal(processingP99({frames:1000,processingHistogram}),1.5);
 processingHistogram[2]=980;processingHistogram[20]=20;
 assert.equal(processingP99({frames:1000,processingHistogram}),10.5);
 processingHistogram[20]=0;processingHistogram[31]=20;
 assert.equal(processingP99({frames:1000,processingHistogram}),null);
 assert.equal(processingP99({frames:999,processingHistogram}),null);
 assert.equal(processingP99({frames:0,processingHistogram:Array(32).fill(0)}),null);
 assert.equal(processingP99(undefined),null);
});
