const $$ = document;
let random = parseInt(Math.random() * 100000000);

let IP = {
    get: (url, type) => fetch(url, { method: 'GET' })
        .then((resp) => {
            if (type === 'text')
                return Promise.all([resp.ok, resp.status, resp.text(), resp.headers]);
            else {
                return Promise.all([resp.ok, resp.status, resp.json(), resp.headers]);
            }
        })
        .then(([ok, status, data, headers]) => {
            if (ok) {
                let json = { ok, status, data, headers }
                return json;
            } else {
                throw new Error(JSON.stringify(json.error));
            }
        }).catch(error => {
            throw error;
        }),

    getJsonp: (url) => {
        var script = document.createElement('script');
        script.src = url
        document.head.appendChild(script);
    },

    parseIPMoeip: (ip, elID) => {
        IP.get(`https://ip.mcr.moe/?ip=${ip}&unicode&z=${random}`, 'json')
            .then(resp => {
                $$.getElementById(elID).innerHTML = `${resp.data.country} ${resp.data.area} ${resp.data.provider}`;
            })
    },

    parseIPIpapi: (ip, elID) => {
        IP.get(`https://ipapi.co/${ip}/json?z=${random}`, 'json')
            .then(resp => {
                $$.getElementById(elID).innerHTML = `${resp.data.country_name} ${resp.data.city} ${resp.data.org}`;
            })
    },

    getWebrtcIP: function() {
        window.RTCPeerConnection = window.RTCPeerConnection || window.mozRTCPeerConnection  || window.webkitRTCPeerConnection;
        var webrtc = new RTCPeerConnection({ iceServers: []}), i = function() {};
        webrtc.createDataChannel("");
        webrtc.createOffer(webrtc.setLocalDescription.bind(webrtc), i);

        webrtc.onicecandidate = function(con) {
            try {
                if (con && con.candidate && con.candidate.candidate) {
                    var webctrip = /([0-9]{1,3}(\.[0-9]{1,3}){3}|[a-f0-9]{1,4}(:[a-f0-9]{1,4}){7})/
                        .exec(con.candidate.candidate)[1];
                    $$.getElementById("ip-webrtc").innerHTML = webctrip;
                    webrtc.onicecandidate = i;
                    $$.getElementById("ip-webrtc-geo").innerHTML = "WebRTC Leaked IP"
                } else {
                    // WebRTC IPs
                    const iceServers = [
                        { urls: 'stun:stun.l.google.com:19302' },
                        { urls: 'stun:stun1.l.google.com:19302' },
                        { urls: 'stun:stun2.l.google.com:19302' },
                        { urls: 'stun:stun3.l.google.com:19302' },
                        { urls: 'stun:stun4.l.google.com:19302' },
                    ];

                    // getUserIPs function
                    async function getUserIPs(callback) {
                        try {
                            const myPeerConnection = new RTCPeerConnection({ iceServers });
                            myPeerConnection.createDataChannel("");
                            const offer = await myPeerConnection.createOffer();
                            await myPeerConnection.setLocalDescription(offer);
                            myPeerConnection.onicecandidate = function(event) {
                                if (event.candidate) {
                                    const parts = event.candidate.candidate.split(' ');
                                    const ip = parts[4];
                                    callback(ip);
                                }
                            };
                        } catch (error) {
                            console.error("Error retrieving IP addresses:", error);
                            callback(null);
                        }
                    }

                    getUserIPs((ip) => {
                        if (ip) {
                            const ipv4Regex = /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
                            const ipv6Regex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}(([0-9a-fA-F]{1,4}:){1,4}|((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/;
                            if (ipv4Regex.test(ip)) {
                                $$.getElementById("ip-webrtc").innerHTML = ip;
                                $$.getElementById("ip-webrtc-geo").innerHTML = "WebRTC Leaked IP"
                            } else if (ipv6Regex.test(ip)) {
                                $$.getElementById("ip-webrtc-geo").innerHTML = "WebRTC IPv6: "+ip;
                            }
                        } else {
                            $$.getElementById("ip-webrtc").innerHTML = "N/A";
                        }
                    });
                }
            } catch {
                $$.getElementById("ip-webrtc").innerHTML = "N/A";
            }
        }
    },

    getIpipnetIP: () => {
        IP.get(`https://myip.ipip.net/?z=${random}`, 'text')
            .then((resp) => {
                let data = resp.data.replace('当前 IP：', '').split(' 来自于：');
                $$.getElementById('ip-ipipnet').innerHTML = `<p id="ip-ipipnet">${data[0]}</p><p class="sk-text-small" id="ip-ipipnet-geo">${data[1]}</p>`;
            });
    },

    getbaidubceIP: () => {
        IP.get(`https://qifu-api.baidubce.com/ip/local/geo/v1/district?r=${random}`, 'json')
            .then(resp => {
                $$.getElementById('ip-baidubce').innerHTML = resp.data.ip;
                $$.getElementById('ip-baidubce-geo').innerHTML = `${resp.data.data.country} ${resp.data.data.prov} ${resp.data.data.city} ${resp.data.data.district} ${resp.data.data.isp}`;
            })    
    },

    getQQIP: () => {
        window.qq = (data) => {
            displayQQData(data);
        };
        IP.getJsonp("https://r.inews.qq.com/api/ip2city?otype=jsonp&callback=qq");
    },

    getIpsbIP: () => {
        IP.get(`https://api.ip.sb/geoip?z=${random}`, 'json')
            .then(resp => {
                $$.getElementById('ip-ipsb').innerHTML = resp.data.ip;
                $$.getElementById('ip-ipsb-geo').innerHTML = `${resp.data.country} ${resp.data.city} ${resp.data.organization}`;
            })
    },

    getIpifyIP: () => {
        IP.get(`https://api.ipify.org/?format=json&z=${random}`, 'json')
            .then(resp => {
                $$.getElementById('ip-ipify').innerHTML = resp.data.ip;
                return resp.data.ip;
            })
            .then(ip => {
                IP.parseIPIpapi(ip, 'ip-ipify-geo');
            })
            .catch(e => {
                console.log('Failed to load resource: api.ipify.org')
            })
    },

    getIpapiIP: () => {
        IP.get(`https://ipapi.co/json?z=${random}`, 'json')
            .then(resp => {
                $$.getElementById('ip-ipapi').innerHTML = resp.data.ip;
                IP.parseIPIpapi(resp.data.ip, 'ip-ipapi-geo');
            })
            .catch(e => {
                console.log('Failed to load resource: ipapi.co')
            })
    },
	getipinfoIP: () => {
        IP.get(`https://ipinfo.io/json?${random}`, 'json')
            .then(resp => {
                $$.getElementById('ip-ipinfo').innerHTML = resp.data.ip;
                $$.getElementById('ip-ipinfo-geo').innerHTML = `${resp.data.country} ${resp.data.city} ${resp.data.org}`;
            })
            .catch(e => {
                console.log('Failed to load resource: ipinfo.co')
            })
    },
	
};

// 定义回调函数，处理 QQ IP 数据
function displayQQData(data) {
    if (data && typeof data === 'object' && data.ip) {
        $$.getElementById('ip-QQ').innerHTML = data.ip;
        $$.getElementById('ip-QQ-geo').innerHTML = `${data.country} ${data.province} ${data.city} ${data.district}`;
    } else {
        console.error('Failed to load QQ IP data');
        $$.getElementById('ip-QQ').innerHTML = '无法加载 QQ IP 数据';
        $$.getElementById('ip-QQ-geo').innerHTML = '';
    }
}

let HTTP = {
    checker: (domain, cbElID) => {
        let img = new Image;
        let timeout = setTimeout(() => {
            img.onerror = img.onload = null;
            img.src = '';
            $$.getElementById(cbElID).innerHTML = '<span class="sk-text-error">连接超时</span>'
        }, 6000);

        img.onerror = () => {
            clearTimeout(timeout);
            $$.getElementById(cbElID).innerHTML = '<span class="sk-text-error">无法访问</span>'
        }

        img.onload = () => {
            clearTimeout(timeout);
            $$.getElementById(cbElID).innerHTML = '<span class="sk-text-success">连接正常</span>'
        }

        img.src = `https://${domain}/favicon.ico?${+(new Date)}`
    },

    runcheck: () => {
        HTTP.checker('www.baidu.com', 'http-baidu');
        HTTP.checker('s1.music.126.net/style', 'http-163');
        HTTP.checker('github.com', 'http-github');
        HTTP.checker('www.youtube.com', 'http-youtube');
    }
};