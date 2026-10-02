(() => {
    const { patcher, metro, ui } = vendetta;
    const { findByProps } = metro;
    const FluxDispatcher = metro.common?.FluxDispatcher ?? findByProps("subscribe", "dispatch");
    const unpatches = [];
    const TAG = "[ForwardDebug]";

    let scan = "";
    let forwards = 0;
    let watchUntil = 0;
    let events = [];
    let timer = null;

    function runScan() {
        const lines = [];
        const add = (id, k, v) => {
            const t = typeof v;
            const shown = t === "number" || t === "boolean" ? v : t === "string" ? JSON.stringify(v.slice(0, 40)) : t;
            lines.push(`${id}:${k}=${shown}`);
        };
        metro.find((m, id) => {
            try {
                for (const h of [m, m?.default]) {
                    if (!h || (typeof h !== "object" && typeof h !== "function")) continue;
                    for (const k of Object.keys(h)) {
                        let v;
                        try { v = h[k]; } catch { continue; }
                        const fwd = /forward/i.test(k);
                        const lim = /(max|limit)/i.test(k) && v === 5;
                        if ((fwd || lim) && lines.length < 120) add(id, k, v);
                    }
                }
            } catch { /* ignore */ }
            return false;
        });
        scan = lines.join("\n");
    }

    function dump() {
        const out = [
            "== ForwardDebug ==",
            `forward requests seen: ${forwards}`,
            "== events after forward ==",
            events.join("\n---\n") || "(none)",
            "== scan (module:key=value) ==",
            scan || "(nothing matched)",
        ].join("\n").slice(0, 9000);
        console.log(TAG, out);
        try {
            const cb = metro.common?.clipboard ?? findByProps("setString");
            cb.setString(out);
            ui.toasts.showToast("ForwardDebug: copied, paste it to Claude");
        } catch (e) {
            ui.toasts.showToast("ForwardDebug: clipboard failed, check debug logs");
        }
    }

    const arm = () => {
        watchUntil = Date.now() + 3000;
        clearTimeout(timer);
        timer = setTimeout(dump, 3500);
    };

    return {
        onLoad() {
            try { runScan(); } catch (e) { scan = "scan failed: " + e; }

            const RestAPI = findByProps("getAPIBaseURL", "get");
            if (RestAPI?.post) {
                unpatches.push(patcher.before("post", RestAPI, (args) => {
                    const ref = args?.[0]?.body?.message_reference;
                    if (ref && (ref.type === 1 || ref.type === "FORWARD")) { forwards++; events = []; arm(); }
                }));
            }
            if (FluxDispatcher?.dispatch) {
                unpatches.push(patcher.before("dispatch", FluxDispatcher, (args) => {
                    if (Date.now() > watchUntil) return;
                    const t = String(args?.[0]?.type);
                    if (/SELECT|NAV|TRANSITION|CHANNEL|FORWARD/i.test(t) && events.length < 25) {
                        const stack = /SELECT|TRANSITION/i.test(t)
                            ? "\n" + String(new Error().stack).split("\n").slice(2, 12).join("\n") : "";
                        events.push(t + stack);
                    }
                }));
            }
            ui.toasts.showToast("ForwardDebug ready: forward one message and wait 4s");
        },
        onUnload() {
            for (const u of unpatches.splice(0)) { try { u(); } catch { /* ignore */ } }
            clearTimeout(timer);
        },
    };
})()
