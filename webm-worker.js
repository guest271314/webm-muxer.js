// metadata flags
const audio_flag = 0b10;

// header flags
const key_flag         = 0b010;
const new_cluster_flag = 0b100;

const max_timestamp_mismatch_warnings = 10;

function onerror(e) {
    console.error(e);
    self.postMessage({
        type: 'error',
        detail: e.message
    });
}

let metadata;
let options;
let webm_muxer;
let first_audio_timestamp = null; // using timestamps on encoded chunks
let next_audio_timestamp = 0; // using durations on encoded chunks
let last_timestamp = -1;
let last_audio_in_timestamp = 0;
let last_audio_out_timestamp = 0;
let audio_msgs_since_last_cluster = 0;
let queued_audio = [];
let num_timestamp_mismatch_warnings = 0;

function send_data(data) {
    webm_muxer.postMessage({
        type: 'stream-data',
        data
    }, [data]);
}

function send_msg(msg) {
    if (msg.timestamp <= last_timestamp)  {
        if (msg.timestamp < last_timestamp) {
            console.warn(`${msg.type} timestamp ${msg.timestamp} is older than last timestamp ${last_timestamp}`);
        }
        msg.timestamp = last_timestamp + 1;
    }
    last_timestamp = msg.timestamp;

    const header = new ArrayBuffer(1);
    new DataView(header).setUint8(0,
        (msg.is_key ? key_flag : 0) |
        (msg.new_cluster ? new_cluster_flag : 0),
        true);

    const timestamp = new ArrayBuffer(8);
    new DataView(timestamp).setBigUint64(0, BigInt(msg.timestamp), true);

    const duration = new ArrayBuffer(8);
    new DataView(duration).setBigUint64(0, BigInt(msg.duration || 0), true);

    send_data(header);
    send_data(timestamp);
    send_data(duration);
    send_data(msg.data);
}

function get_audio_ts(amsg) {
    const atimestamp = last_audio_out_timestamp + (amsg.timestamp - last_audio_in_timestamp);
    if (atimestamp <= last_timestamp) {
        if (atimestamp < last_timestamp) {
            console.warn(`audio timestamp ${atimestamp} is older than last timestamp ${last_timestamp}`);
        }
        return last_timestamp + 1;
    }
    return atimestamp;
}

function set_audio_ts(amsg, atimestamp) {
    last_audio_in_timestamp = amsg.timestamp;
    amsg.timestamp = atimestamp;
    last_audio_out_timestamp = atimestamp;
    return amsg;
}

function send_msgs(opts) {
    if (!metadata.video) {
        while (queued_audio.length > 0) {
            send_msg(queued_audio.shift());
        }
        return;
    }

    while (queued_audio.length > 0) {
        const atimestamp = get_audio_ts(queued_audio[0]);
        send_msg(set_audio_ts(queued_audio.shift(), atimestamp));
    }

    while (queued_audio.length > opts.audio_queue_limit) {
        const msg = queued_audio.shift();
        if ((queued_audio.length === opts.audio_queue_limit) &&
            (++audio_msgs_since_last_cluster > opts.audio_queue_limit)) {
            msg.new_cluster = true;
            audio_msgs_since_last_cluster = 0;
        }
        const atimestamp = get_audio_ts(msg);
        send_msg(set_audio_ts(msg, atimestamp));
    }
}

function send_metadata(metadata) {
    const max_cluster_duration = new ArrayBuffer(8);
    new DataView(max_cluster_duration).setBigUint64(0, metadata.max_segment_duration || BigInt(0), true);;
    send_data(max_cluster_duration);

    const flags = new ArrayBuffer(1);
    new DataView(flags).setUint8(0,
        (metadata.audio ? audio_flag : 0),
        true);
    send_data(flags);

    if (metadata.audio) {
        const sample_rate = new ArrayBuffer(4);
        new DataView(sample_rate).setInt32(0, metadata.audio.sample_rate, true);
        send_data(sample_rate);

        const channels = new ArrayBuffer(4);
        new DataView(channels).setInt32(0, metadata.audio.channels, true);
        send_data(channels);

        const bit_depth = new ArrayBuffer(4);
        new DataView(bit_depth).setInt32(0, metadata.audio.bit_depth || 0, true);
        send_data(bit_depth);

        send_data(new TextEncoder().encode(metadata.audio.codec_id).buffer);

        if (metadata.audio.codec_id === 'A_OPUS') {
            // Adapted from https://github.com/kbumsik/opus-media-recorder/blob/master/src/ContainerInterface.cpp#L27
            // See also https://datatracker.ietf.org/doc/html/rfc7845#section-5.1

            const codec_private = new ArrayBuffer(19);
            new TextEncoder().encodeInto('OpusHead', new Uint8Array(codec_private)); // magic

            const view = new DataView(codec_private);
            view.setUint8(8, 1); // version
            view.setUint8(9, metadata.audio.channels); // channel count
            view.setUint16(10, metadata.audio.pre_skip || 0, true); // pre-skip
            view.setUint32(12, metadata.audio.sample_rate, true); // sample rate
            view.setUint16(16, metadata.audio.output_gain || 0, true); // output gain
            view.setUint8(18, 0, true); // mapping family

            send_data(codec_private);
        } else {
            send_data(new ArrayBuffer(0));
        }

        const seek_pre_roll = new ArrayBuffer(8);
        new DataView(seek_pre_roll).setBigUint64(0,
                metadata.audio.seek_pre_roll || BigInt(metadata.audio.codec_id === 'A_OPUS' ? 80000 : 0),
                true);
        send_data(seek_pre_roll);
    }

    self.postMessage({type: 'start-stream'});
}

onmessage = function (e) {
    const msg = e.data;
    switch (msg.type) {
        case 'audio-data':
            if (metadata.audio) {
                if (first_audio_timestamp === null) {
                    first_audio_timestamp = msg.timestamp;
                }
                const timestamp = msg.timestamp - first_audio_timestamp;
                if (!msg.duration && (next_audio_timestamp >= 0)) {
                    console.warn('no audio duration');
                    next_audio_timestamp = -1;
                }
                if (next_audio_timestamp >= 0) {
                    msg.timestamp = next_audio_timestamp;
                    next_audio_timestamp += msg.duration;
                    if ((msg.timestamp !== timestamp) &&
                        (++num_timestamp_mismatch_warnings <= max_timestamp_mismatch_warnings)) {
                        console.warn(`timestamp mismatch: timestamp=${timestamp} durations=${msg.timestamp}`);
                        if (num_timestamp_mismatch_warnings === max_timestamp_mismatch_warnings) {
                            console.warn('supressing further timestamp mismatch warnings');
                        }
                    }
                } else {
                    msg.timestamp = timestamp;
                }
                queued_audio.push(msg);
                send_msgs(options);
            }
            break;

        case 'start': {
            metadata = msg.webm_metadata;
            options = {
                audio_queue_limit: Infinity,
                use_audio_timestamps: false,
                ...msg.webm_options
            };
            delete msg.webm_metadata;
            delete msg.webm_options;

            if (options.use_audio_timestamps) {
                next_audio_timestamp = -1;
            }

            webm_muxer = new Worker('./webm-muxer.js');
            webm_muxer.onerror = onerror;

            webm_muxer.onmessage = function (e) {
                const msg2 = e.data;
                switch (msg2.type) {
                    case 'ready':
                        webm_muxer.postMessage(msg);
                        break;

                    case 'start-stream':
                        send_metadata(metadata);
                        break;

                    case 'exit':
                        webm_muxer.terminate();
                        self.postMessage(msg2);
                        break;

                    case 'muxed-data':
                        self.postMessage(msg2, [msg2.data]);
                        break;

                    default:
                        self.postMessage(msg2, msg2.transfer);
                        break;
                }
            };

            break;
        }

        case 'end': {
            if (webm_muxer) {
                if (queued_audio.length > 0) {
                    queued_audio[0].new_cluster = true;
                }
                send_msgs({ audio_queue_limit: 0 });
                webm_muxer.postMessage(msg);
            }
            break;
        }
    }
};
