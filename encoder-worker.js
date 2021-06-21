function onerror(e) {
    console.error(e);
    self.postMessage({
        type: 'error',
        detail: e
    });
}

onmessage = async function (e) {
    const msg = e.data;
    switch (msg.type) {
        case 'start':
            try {
                const Encoder = msg.audio ? AudioEncoder : VideoEncoder;
                const type = msg.audio ? 'audio-data' : 'video-data';
                const key_frame_interval = msg.key_frame_interval * 1000;
                const encoder = new Encoder({
                    output: chunk => {
                        //const data = new ArrayBuffer(chunk.byteLength);
                        //chunk.copyTo(data);
                        const data = chunk.data.slice(0, chunk.byteLength);
                        self.postMessage({
                            type,
                            timestamp: chunk.timestamp,
                            duration: chunk.duration,
                            is_key: msg.audio || chunk.type === 'key',
                            data
                        }, [data]);
                    },
                    error: onerror
                });
                await encoder.configure(msg.config);

                const reader = msg.readable.getReader();
                let last_key_frame = -1;

                while (true) {
                    const result = await reader.read();
                    if (result.done) {
                        break;
                    }
                    if (msg.audio) {
                        encoder.encode(result.value);
                    } else {
                        const now = Date.now();
                        const keyFrame = (key_frame_interval > 0) &&
                                         ((now - last_key_frame) > key_frame_interval);
                        if (keyFrame) {
                            last_key_frame = now;
                        }
                        encoder.encode(result.value, { keyFrame });
                    }
                    result.value.close();
                }
            } catch (ex) {
                onerror(ex);
            }

            break;
    }
};