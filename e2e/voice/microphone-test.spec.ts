import { expect, test } from './support/peer-browser';
import { watchContexts } from './support/leaks';
import { VoicePeer, WAIT, copy, onboard, openVoiceSettings } from './support/voice';
watchContexts(test);
test('the local microphone test stops capture before playback and discards its recording',async({peerBrowser})=>{
  const peer=peerBrowser.track(await VoicePeer.start()),alice=await peerBrowser.open('alice');
  try {
    await peer.setup();await onboard(alice,peer,'alice');
    await alice.page.evaluate(()=>{
      const streams:MediaStream[]=[];
      (window as unknown as {previewStreams:MediaStream[]}).previewStreams=streams;
      const gum=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia=async constraints=>{const stream=await gum(constraints);streams.push(stream);return stream;};
    });
    const dialog=await openVoiceSettings(alice.page);
    await dialog.getByRole('button',{name:copy('settings.voice.test'),exact:true}).click();
    const stop=dialog.getByRole('button',{name:copy('settings.voice.testStop'),exact:true});
    await expect(stop).toBeVisible({timeout:WAIT});
    await expect(dialog.getByRole('meter',{name:copy('settings.voice.level'),exact:true})).toHaveCount(0);
    await expect(dialog.getByText(copy('settings.voice.levelUnavailable'),{exact:true})).toBeVisible();
    await stop.click();
    const playback=dialog.getByLabel(copy('settings.voice.testPlayback'),{exact:true});
    await expect(playback).toHaveAttribute('src',/^blob:/,{timeout:WAIT});
    expect(await alice.page.evaluate(()=>{
      const streams=(window as unknown as {previewStreams:MediaStream[]}).previewStreams;
      return streams.length>0&&streams.every(s=>s.getTracks().every(t=>t.readyState==='ended'));
    })).toBe(true);
    await playback.evaluate((audio:HTMLAudioElement)=>audio.play());
    await dialog.getByRole('button',{name:copy('settings.voice.testClose'),exact:true}).click();
    await expect(playback).toHaveCount(0);
    await expect(dialog.getByRole('meter',{name:copy('settings.voice.level'),exact:true})).toBeVisible();
  }finally{await peerBrowser.close(alice);await peer.close();}
});
