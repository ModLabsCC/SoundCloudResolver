export default {
    async fetch(request, env, ctx) {
        return handleRequest(request, env, ctx);
    },
};

const globalHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': '*',
    'Access-Control-Allow-Headers': '*'
};

async function fetchWithRetry(url, options = {}, retries = 3, backoff = 500) {
    let lastError;
    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            const response = await fetch(url, options);
            if (response.ok) return response;
            lastError = new Error(`Fetch failed (${response.status}): ${response.statusText}`);
        } catch (err) {
            lastError = err;
        }
        await new Promise(res => setTimeout(res, backoff * (attempt + 1)));
    }
    return fetch(url, options);
}

async function serveAsset(request, env, ctx) {
    const url = new URL(request.url);
    let response = await caches.default.match(request);

    try {
        if (!response) {
            if (url.pathname === "/favicon.ico") {
                await fetch("https://modlabs.cc/favicon.ico").then(async function (tmpResp) {
                    const headers = {
                        ...globalHeaders,
                        'cache-control': 'public, max-age=14400',
                        'Content-Length': tmpResp.headers.get("content-length"),
                        'Content-Type': tmpResp.headers.get("content-type")
                    };
                    response = new Response(tmpResp.body, {...tmpResp, headers, status: 200});
                    ctx.waitUntil(caches.default.put(request, response.clone()));
                }).catch(function (err) {
                    response = new Response("Error while resolving URL: " + err.toString(), {status: 422});
                });
                return response;
            }

            let currentUrl = "https://w.soundcloud.com/player/";

            console.log(currentUrl);
            let req = await fetch(currentUrl);
            req = await req.text();
            let jsFile = req.split("sndcdn.com/widget-9-")[1].split('.js')[0];

            currentUrl = `https://widget.sndcdn.com/widget-9-${jsFile}.js`;
            console.log(currentUrl);
            req = await fetch(currentUrl);
            req = await req.text();

            let soundCloudID = req.split("client_id")[1].split('"')[1];

            currentUrl = "https://api-v2.soundcloud.com/resolve?url=https://soundcloud.com" + url.pathname + "&client_id=" + soundCloudID;
            console.log(currentUrl);
            await fetch(currentUrl).then(async function (tmpResp) {

                let tmpJson = await tmpResp.json();
                    switch (tmpJson.kind) {
                        case "track":

                            let streamUrl = "";
                            console.log(tmpJson);
                            for(const transocing of tmpJson.media.transcodings) {
                                if(transocing.format.mime_type === "audio/mpeg") {
                                    streamUrl = transocing.url;
                                    break;
                                }
                            }

                            if(streamUrl === "") {
                                response = new Response("", {statusText: "Couldn't find HLS stream url", status: 422})
                                break;
                            }

                            streamUrl = streamUrl + "?client_id=" + soundCloudID;

                            console.log(streamUrl);
                            streamUrl = await fetch(streamUrl);
                            streamUrl = await streamUrl.json();
                            streamUrl = streamUrl.url;

                            console.log("wrapped stream url", streamUrl)

                            // Implementing the Fetch HLS playlist, concatenate MP3 parts, and serve as a single MP3 file
                            let playlistResponse = await fetch(streamUrl);
                            let playlistText = await playlistResponse.text();

                            // Parse the playlist to get MP3 part URLs
                            let lines = playlistText.split('\n');
                            let mediaUrls = [];
                            for (let line of lines) {
                                line = line.trim();
                                if (line && !line.startsWith('#')) {
                                    let mediaUrl = new URL(line, streamUrl).toString();
                                    mediaUrls.push(mediaUrl);
                                }
                            }

                            // Create a TransformStream to pipe the MP3 parts
                            let { readable, writable } = new TransformStream();

                            (async () => {
                                const writer = writable.getWriter();

                                try {
                                    for (let mediaUrl of mediaUrls) {
                                        const partResponse = await fetchWithRetry(mediaUrl);
                                        if (!partResponse.ok) {
                                            throw new Error(`Failed to fetch MP3 part: ${mediaUrl}`);
                                        }
                                        const reader = partResponse.body.getReader();
                                        while (true) {
                                            const { done, value } = await reader.read();
                                            if (done) break;
                                            await writer.write(value);
                                        }
                                    }
                                    await writer.close();
                                } catch (error) {
                                    console.error(error);
                                    await writer.abort(error);
                                }
                            })();

                            var headers = {
                                ...globalHeaders,
                            };
                            headers['cache-control'] = "public, max-age=14400";
                            headers['Content-Type'] = "audio/mpeg";
                            headers['Content-Disposition'] = `filename="${tmpJson.user.username} - ${tmpJson.title}.mp3"`;
                            headers['X-Content-Duration'] = tmpJson.duration / 1000;
                            response = new Response(readable, {headers});
                            ctx.waitUntil(caches.default.put(request, response.clone()));
                            break;
                        case "playlist":
                            let tracks = tmpJson.tracks;

                            for(let i = 0; i < tracks.length; i++) {
                                let trck = await fetch("https://api-v2.soundcloud.com/tracks/" + tracks[i].id + "?client_id=" + soundCloudID);
                                tracks[i] = await trck.json();
                            }

                            let outStr = `#EXTM3U\n`;
                            for (let track of tracks) {
                                outStr += generateOutStr(track);
                            }
                            var ctType = "application/x-mpegURL";
                            var headers = {
                                ...globalHeaders,
                                'cache-control': 'public, max-age=14400',
                                'Content-Type': ctType
                            };
                            response = new Response(outStr, {headers, statusText: "OK", status: 200});
                            ctx.waitUntil(caches.default.put(request, response.clone()));
                            break;
                        default:
                            var headers = {
                                ...globalHeaders,
                                'cache-control': 'public, max-age=14400',
                                'content-type': "plain/html",
                                'Content-Encoding': 'deflate'
                            }
                            response = new Response("NOT IMPLEMENTED YET!", {
                                headers,
                                statusText: "Not Implemented",
                                status: 501
                            });
                            break;
                    }
            }).catch(function (er) {
                console.error(er);
                response = new Response("", {statusText: "Error while resolving URL", status: 422})
            });
        }
    } catch (err) {
        console.error(err);
        response = new Response(err.toString(), {statusText: "Error while resolving URL", status: 422})
    }

    return response;
}

function generateOutStr(track) {
    let tmp = `#EXTINF:${track.duration / 1000} tvg-id="" tvg-name="${track.user.username} - ${track.title}" tvg-country="" tvg-language="" tvg-logo="" group-title="",${track.user.username} - ${track.title}\n`;
    tmp += track.permalink_url.replace("soundcloud.com", "api.modlabs.cc/scr") + `\n`;
    return tmp
}

async function handleRequest(request, env, ctx) {
    if (request.method === 'GET') {
        let response= await serveAsset(request, env, ctx);
        if (response.status > 399) {
            response = new Response(response.statusText + `(${response.status}) (C)ModLabs`, {status: response.status})
        }
        return response
    } else {
        return new Response('Method not allowed', {status: 405})
    }
}
