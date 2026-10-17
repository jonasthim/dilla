#!/usr/bin/env python3
"""Acquire a reproducible, attributed 60-clip speech set. Requires requests, pyarrow, numpy, ffmpeg.
Outputs stay in ignored output/. The 16 kHz source limits full-band qualification.
"""
import hashlib, json, subprocess, io, wave
from pathlib import Path
import requests
import pyarrow.parquet as pq
import numpy as np
HERE=Path(__file__).resolve().parent
OUT=HERE/'output'/'fleurs'; OUT.mkdir(parents=True,exist_ok=True)
SOURCES={
 'sv_se':'4699f114728f60b832f1bac005d2161e4aff745f9c5a72ca67978a36f742a8f4',
 'en_us':'7c3eeb11a9597bd52cdc1b0d637e85389fe094cfd8763913e7bf4fdf7a853959',
}
clips=[]
for lang,sha in SOURCES.items():
    url=f'https://huggingface.co/datasets/google/fleurs/resolve/refs%2Fconvert%2Fparquet/{lang}/validation/0000.parquet'
    target=OUT/f'{lang}.parquet'
    if not target.exists():
        print('Downloading',lang,flush=True)
        with requests.get(url,stream=True,timeout=120) as r:
            r.raise_for_status()
            with target.open('wb') as f:
                for chunk in r.iter_content(1024*1024):f.write(chunk)
    if hashlib.sha256(target.read_bytes()).hexdigest()!=sha:raise ValueError('Dataset hash changed')
    rows=pq.read_table(target).slice(0,30).to_pylist()
    speech=[]
    for row in rows:
        raw=subprocess.run(['ffmpeg','-v','error','-i','pipe:0','-ac','1','-ar','48000','-f','f32le','pipe:1'],input=row['audio']['bytes'],capture_output=True,check=True).stdout
        speech.append(np.frombuffer(raw,dtype='<f4').copy())
    for n,(row,pcm) in enumerate(zip(rows,speech)):
        # Each clip is unique; deterministic variants are recorded explicitly, never represented as natural recordings.
        category=['clean','quiet','onset','fan','keyboard','tv','overlap'][n%7]
        pcm=pcm[:48000*10]
        pcm=pcm/max(.001,float(np.sqrt(np.mean(pcm*pcm))))*.05
        if category=='quiet':pcm*=.2
        if category=='fan':
            t=np.arange(len(pcm))/48000
            rng=np.random.default_rng(n);pcm+=.018*np.sin(2*np.pi*110*t)+rng.normal(0,.012,len(pcm))
        if category=='keyboard':
            rng=np.random.default_rng(n)
            for at in range(12000,len(pcm),17000):
                count=min(1500,len(pcm)-at);pcm[at:at+count]+=rng.normal(0,.1,count)*np.exp(-np.arange(count)/150)
        if category in ['tv','overlap']:
            other=np.resize(speech[(n+7)%len(rows)],len(pcm));other=other/max(.001,float(np.sqrt(np.mean(other*other))))*(.015 if category=='tv' else .05);pcm+=other
        samples=(np.clip(pcm,-1,1)*32767).astype('<i2');name=f'{lang}-{n:02d}.wav'
        with wave.open(str(OUT/name),'wb') as f:f.setnchannels(1);f.setsampwidth(2);f.setframerate(48000);f.writeframes(samples.tobytes())
        data=(OUT/name).read_bytes()
        clips.append({'id':f'fleurs-{lang}-{n:02d}','file':name,'sha256':hashlib.sha256(data).hexdigest(),'language':'sv' if lang=='sv_se' else 'en','categories':[category],'license':'CC-BY-4.0','consent':None,'source':url,'sourceSha256':sha,'attribution':'Google FLEURS / Conneau et al., 2022, https://huggingface.co/datasets/google/fleurs','sourceId':row['id'],'transcript':row['raw_transcription'],'originalRate':16000,'transform':f'ffmpeg resample to 48 kHz, first 10 seconds, RMS .05; {category} deterministic variant (synthetic noise or FLEURS speech mix); not manually onset-annotated'})
report={'clips':clips,'limitations':['16 kHz speech resampled to 48 kHz; does not qualify full-band naturalness.','Fan/keyboard noise is synthetic; TV is a quiet speech mix. Dogs and actual TV/keyboard/fan recordings remain missing.','Transcripts cover the original clip, which may exceed the retained 10 seconds. Human onset annotation required.','No Krisp reference or listening scores supplied.']}
(OUT/'corpus.json').write_text(json.dumps(report,indent=2)+'\n')
(HERE/'results'/'fleurs-corpus.json').write_text(json.dumps(report,indent=2)+'\n')
print('Saved 60 attributed clips and manifest',flush=True)
