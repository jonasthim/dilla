import {noiseBuild} from '../../scripts/noise-build.mjs';
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
export default defineConfig({plugins:[noiseBuild('evaluation')],root:fileURLToPath(new URL('.',import.meta.url)),server:{host:'127.0.0.1',port:5191,strictPort:true,fs:{allow:[fileURLToPath(new URL('../..',import.meta.url))]}},worker:{format:'es'},optimizeDeps:{include:['@jitsi/rnnoise-wasm/dist/rnnoise-sync.js']}});
