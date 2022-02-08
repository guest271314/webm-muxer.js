import { WebMWriter } from './webm-writer.js';

function onerror(e) {
    console.error(e);
}

const start_el = document.getElementById('start');
const stop_el = document.getElementById('stop');
const record_el = document.getElementById('record');
const pcm_el = document.getElementById('pcm');
const inmem_el = document.getElementById('in-memory');
let audio_track;

const video = document.getElementById('video');
video.onerror = () => onerror(video.error);
const poster = video.poster;

record_el.addEventListener('input', function () {
    if (this.checked) {
        pcm_el.disabled = false;
        pcm_el.checked = pcm_el.was_checked;
        inmem_el.disabled = false;
        inmem_el.checked = inmem_el.was_checked;
    } else {
        pcm_el.disabled = true;
        pcm_el.was_checked = pcm_el.checked;
        pcm_el.checked = false;
        inmem_el.disabled = true;
        inmem_el.was_checked = inmem_el.checked;
        inmem_el.checked = false;
    }
});
pcm_el.disabled = true;
inmem_el.disabled = true;

// See https://www.webmproject.org/vp9/mp4/
// and also https://googlechrome.github.io/samples/media/vp9-codec-string.html

let writer;
start_el.addEventListener('click', async function () {
    this.disabled = true;
    record_el.disabled = true;
    pcm_el.disabled = true;
    inmem_el.disabled = true;

    const rec_info = document.getElementById('rec_info');
    if (record_el.checked) {
        writer = new WebMWriter();
        try {
            await writer.start('camera.webm');
        } catch (ex) {
            this.disabled = false;
            record_el.disabled = false;
            pcm_el.disabled = !record_el.checked;
            inmem_el.disabled = !record_el.checked;
            throw ex;
        }
        rec_info.innerText = 'Recording';
    } else {
        rec_info.innerText =  '';
    }

    const buf_info = document.getElementById('buf_info');
    if (!pcm_el.checked) {
        buf_info.innerText = 'Buffering';
    }
    const ac = new AudioContext();
    const msd = new MediaStreamAudioDestinationNode(ac);
    const { stream } = msd;
    const osc = new OscillatorNode(ac, {frequency: 200});
    osc.connect(msd);
    osc.start();
/*
    const stream = await navigator.mediaDevices.getUserMedia({
        audio: true
    });
*/
    audio_track = stream.getAudioTracks()[0];
    const audio_readable = (new MediaStreamTrackProcessor(audio_track)).readable;
    const audio_settings = audio_track.getSettings();
    console.log(audio_settings);
    let num_exits = 0;

    function relay_data(ev) {
        const msg = ev.data;
        switch (msg.type) {
            case 'error':
                onerror(msg.detail)
                break;

            case 'exit':
                if (++num_exits === 2) {
                    webm_worker.postMessage({ type: 'end' });
                }
                break;

            default:
                webm_worker.postMessage(msg, [msg.data]);
                break;
        }
    }

    const audio_worker = new Worker('./encoder-worker.js');
    audio_worker.onerror = onerror;
    audio_worker.onmessage = relay_data;

    let exited = false;
    let buffer;
    const queue = [];
    const key_frame_interval = 1;
    const buffer_delay = 2;

    const webm_worker = new Worker('./webm-worker.js');
    webm_worker.onerror = onerror;
    webm_worker.onmessage = async ev => {
        const msg = ev.data;
        switch (msg.type) {
            case 'exit':
                if (msg.code !== 0) {
                    onerror(`muxer exited with status ${msg.code}`);
                }
                webm_worker.terminate();
                audio_worker.terminate();
                exited = true;

                if (record_el.checked) {
                    const r = await writer.finish();
                    rec_info.innerText = `Finished: Duration ${writer.duration}ms, Size ${writer.size} bytes`;
                    if (inmem_el.checked) {
                        const blob = new Blob(r, { type: 'video/webm' });
                        const a = document.createElement('a');
                        const filename = 'camera.webm';
                        a.textContent = filename;
                        a.href = URL.createObjectURL(blob);
                        a.download = filename;
                        document.body.appendChild(a);
                        a.click();
                        document.body.removeChild(a);
                    } else {
                        rec_info.innerText += `, Filename ${writer.name}, Cues at ${r ? 'start' : 'end'}`;
                    }
                }

                start_el.disabled = false;
                record_el.disabled = false;
                pcm_el.disabled = !record_el.checked;
                inmem_el.disabled = !record_el.checked;

                break;

            case 'start-stream':

                audio_worker.postMessage({
                    type: 'start',
                    audio: true,
                    readable: audio_readable,
                    config: {
                        codec: pcm_el.checked ? 'pcm' : 'opus',
                        bitrate: 128 * 1000,
                        sampleRate: audio_settings.sampleRate,
                        numberOfChannels: audio_settings.channelCount
                    }
                }, [audio_readable]);

                stop_el.disabled = false;

                break;

            case 'muxed-data':
                if (record_el.checked) {
                    await writer.write(msg.data);
                    rec_info.innerText = `Recorded ${writer.size} bytes`;
                }
                queue.push(msg.data);
                if (!pcm_el.checked) {
                    remove_append();
                }
                break;

            case 'error':
                onerror(msg.detail);
                break;
        }
    };

    function remove_append() {
        if (buffer.updating) {
            return;
        }
        if (exited) {
            if (video.src) {
                buffer.removeEventListener('updateend', remove_append);
                buf_info.innerText = '';
                source.endOfStream();
                video.pause();
                video.removeAttribute('src');
                video.currentTime = 0;
                video.poster = poster;
                video.load();
            }
            return;
        }
        const range = buffer.buffered;
        if (range.length > 0) {
            buf_info.innerText = `Buffered ${range.start(0)} .. ${range.end(0)}`;
        }
        if ((video.currentTime === 0) &&
            ((buffer_delay === 0) ||
             ((range.length > 0) && (range.end(0) > buffer_delay)))) {
            video.poster = '';
            video.play();
        }
        const check = video.currentTime - key_frame_interval * 2;
        if ((range.length > 0) && (range.start(0) < check)) {
            buffer.remove(0, check);
        } else if (queue.length > 0) {
            buffer.appendBuffer(queue.shift());
        }
    }

    function start() {
        webm_worker.postMessage({
            type: 'start',
            //webm_receiver: './test-receiver.js',
            webm_metadata: {
                max_segment_duration: BigInt(1000000000),
                audio: {
                    bit_depth: pcm_el.checked ? 32 : 0,
                    sample_rate: audio_settings.sampleRate,
                    channels: audio_settings.channelCount,
                    codec_id: pcm_el.checked ? 'A_PCM/FLOAT/IEEE' : 'A_OPUS'
                }
            }
        });
    }

    if (pcm_el.checked) {
        return start();
    }

    const source = new MediaSource();
    video.src = URL.createObjectURL(source);

    source.addEventListener('sourceopen', function () {
        buffer = this.addSourceBuffer('video/webm; codecs=opus');
        buffer.addEventListener('updateend', remove_append);
        start();
    });
});

stop_el.addEventListener('click', async function () {
    this.disabled = true;
    audio_track.stop();
    await writer.finish();
});
