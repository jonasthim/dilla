#!/usr/bin/env python3
"""Offline native challenger. No microphone, network, telemetry or external Python packages."""
import array, ctypes as c, json, sys, time
libpath, modelpath, source, destination = sys.argv[1:]
lib = c.CDLL(libpath)
for name, args, result in [
    ('weya_nc_model_load_from_path', [c.c_char_p], c.c_void_p),
    ('weya_nc_session_create', [c.c_void_p,c.c_size_t,c.c_float], c.c_void_p),
    ('weya_nc_get_frame_length', [c.c_void_p], c.c_size_t),
    ('weya_nc_process_frame', [c.c_void_p,c.POINTER(c.c_float),c.POINTER(c.c_float)], c.c_float),
    ('weya_nc_session_free', [c.c_void_p], None), ('weya_nc_model_free',[c.c_void_p],None),
]:
    fn=getattr(lib,name); fn.argtypes=args; fn.restype=result
model=lib.weya_nc_model_load_from_path(modelpath.encode())
if not model: raise RuntimeError('Hush model load failed')
session=lib.weya_nc_session_create(model,48000,100)
if not session: lib.weya_nc_model_free(model); raise RuntimeError('Hush session failed')
try:
    size=lib.weya_nc_get_frame_length(session)
    pcm=array.array('f'); pcm.frombytes(open(source,'rb').read())
    if sys.byteorder != 'little': pcm.byteswap()
    out=array.array('f'); a=(c.c_float*size)(); b=(c.c_float*size)(); timings=[]
    for at in range(0,len(pcm)+4800,size):
        for i in range(size): a[i]=pcm[at+i] if at+i<len(pcm) else 0
        start=time.perf_counter(); lib.weya_nc_process_frame(session,a,b); timings.append((time.perf_counter()-start)*1000)
        out.extend(b)
    if sys.byteorder != 'little': out.byteswap()
    open(destination,'wb').write(out.tobytes())
    timings.sort()
    print(json.dumps({'frames':len(timings),'meanMs':sum(timings)/len(timings),'p99Ms':timings[min(len(timings)-1,int(len(timings)*0.99))],'modelRate':16000,'frameMs':size/48,'addedDelayMs':None,'runtime':'native CPU; not a browser measurement','resampling':'upstream linear interpolation 48k/16k/48k','alignment':'uncompensated; includes 100 ms tail padding'}))
finally:
    lib.weya_nc_session_free(session); lib.weya_nc_model_free(model)
