(() => {
    // NOTE: Kettu evaluates this file as `return <expression>`, so it must stay a single
    // expression starting on line 1 (no leading comments / blank lines above the IIFE).
    const { patcher, metro, ui } = vendetta;
    const { findByProps } = metro;
    const FluxDispatcher = metro.common?.FluxDispatcher ?? findByProps("subscribe", "dispatch");

    const TAG = "[ForwardPlus]";
    const log = (...a) => console.log(TAG, ...a);

    const BIG = 9999;          // new "max destinations"
    const HOLD_MS = 1500;      // keep blocking navigation this long after the last forward finishes

    const unpatches = [];
    const restoreFns = [];
    const stats = { limitValues: 0, limitFns: 0, nav: 0, send: 0, dispatch: 0 };

    // ---------------------------------------------------------------- forward tracking
    const tracked = new WeakSet();
    let inFlight = 0;
    let holdUntil = 0;
    const blocking = () => inFlight > 0 || Date.now() < holdUntil;
    const touch = () => { holdUntil = Date.now() + HOLD_MS; };

    const isForwardRef = (ref) => !!ref && (ref.type === 1 || ref.type === "FORWARD");

    function hookForwardRequests() {
        // Every forward is a normal message POST with message_reference.type === 1.
        const RestAPI = findByProps("getAPIBaseURL", "get");
        if (RestAPI?.post) {
            unpatches.push(
                patcher.before("post", RestAPI, (args) => {
                    const ref = args?.[0]?.body?.message_reference;
                    if (isForwardRef(ref)) { inFlight++; touch(); tracked.add(args[0]); }
                })
            );
            unpatches.push(
                patcher.after("post", RestAPI, (args, ret) => {
                    if (!args?.[0] || !tracked.has(args[0])) return;
                    const done = () => { inFlight = Math.max(0, inFlight - 1); touch(); };
                    if (ret && typeof ret.then === "function") ret.then(done, done);
                    else done();
                })
            );
            stats.send++;
        }

        // Earlier signal (before the request is even built), if the action exists.
        const MessageActions = findByProps("sendMessage", "receiveMessage");
        if (MessageActions?.sendMessage) {
            unpatches.push(
                patcher.before("sendMessage", MessageActions, (args) => {
                    if (isForwardRef(args?.[2]?.messageReference)) touch();
                })
            );
            stats.send++;
        }
    }

    // ---------------------------------------------------------------- stay in the current channel
    function blockNavigation() {
        const names = [
            "transitionToGuild",
            "transitionToChannel",
            "transitionTo",
            "selectChannel",
            "navigateToChannel",
            "openChannel",
        ];
        const seen = new Set();
        for (const name of names) {
            let mod;
            try { mod = findByProps(name); } catch { continue; }
            if (!mod || typeof mod[name] !== "function" || seen.has(mod[name])) continue;
            seen.add(mod[name]);
            try {
                unpatches.push(
                    patcher.instead(name, mod, (args, orig) => (blocking() ? undefined : orig(...args)))
                );
                stats.nav++;
            } catch (e) { log("could not patch", name, e); }
        }

        // Fallback only: if no router function was found, at least stop the channel-select event.
        if (!stats.nav && FluxDispatcher?.dispatch) {
            unpatches.push(
                patcher.instead("dispatch", FluxDispatcher, (args, orig) => {
                    if (blocking() && args?.[0]?.type === "CHANNEL_SELECT") return;
                    return orig(...args);
                })
            );
            stats.dispatch++;
        }
    }

    // ---------------------------------------------------------------- remove the 5 destination cap
    function removeLimit() {
        const nameLooksLikeLimit = (k) =>
            (/forward/i.test(k) && /(max|limit)/i.test(k)) ||
            (/(destination|recipient|target)/i.test(k) && /(max|limit)/i.test(k) && /forward|share/i.test(k));

        const hits = [];
        metro.find((m) => {
            try {
                for (const holder of [m, m?.default]) {
                    if (!holder || (typeof holder !== "object" && typeof holder !== "function")) continue;
                    for (const k of Object.keys(holder)) {
                        if (!nameLooksLikeLimit(k)) continue;
                        hits.push([holder, k]);
                    }
                }
            } catch { /* some modules throw on property access */ }
            return false;
        });

        for (const [holder, k] of hits) {
            try {
                const val = holder[k];
                if (typeof val === "number") {
                    if (val > 1 && val < BIG) {
                        const desc = Object.getOwnPropertyDescriptor(holder, k);
                        try { holder[k] = BIG; } catch { /* frozen */ }
                        if (holder[k] !== BIG && desc?.configurable) {
                            Object.defineProperty(holder, k, { value: BIG, writable: true, configurable: true, enumerable: desc.enumerable });
                        }
                        if (holder[k] === BIG) {
                            restoreFns.push(() => { try { Object.defineProperty(holder, k, { value: val, writable: true, configurable: true, enumerable: true }); } catch { /* ignore */ } });
                            stats.limitValues++;
                            log("limit constant patched:", k, val, "->", BIG);
                        }
                    }
                } else if (typeof val === "function") {
                    // e.g. getMaxForwardDestinations() / isForwardLimitReached()
                    const reached = /reach|exceed|isAt|hasHit|isOver|isFull/i.test(k);
                    unpatches.push(
                        patcher.after(k, holder, (_args, ret) => {
                            if (reached) return false;
                            if (typeof ret === "number" && ret > 1 && ret < BIG) return BIG;
                            return ret;
                        })
                    );
                    stats.limitFns++;
                    log("limit function patched:", k);
                } else {
                    log("limit candidate (unhandled type):", k, typeof val);
                }
            } catch (e) { log("could not patch limit candidate", k, e); }
        }
    }

    return {
        onLoad() {
            try { hookForwardRequests(); } catch (e) { log("request hook failed", e); }
            try { blockNavigation(); } catch (e) { log("nav block failed", e); }
            try { removeLimit(); } catch (e) { log("limit removal failed", e); }

            log("loaded", JSON.stringify(stats));
            try {
                ui.toasts.showToast(
                    `ForwardPlus: limit ${stats.limitValues + stats.limitFns ? "patched" : "NOT found"}, ` +
                    `nav ${stats.nav + stats.dispatch ? "blocked" : "NOT found"}`
                );
            } catch { /* toast is cosmetic */ }
        },
        onUnload() {
            for (const un of unpatches.splice(0)) { try { un(); } catch { /* ignore */ } }
            for (const fn of restoreFns.splice(0)) fn();
            inFlight = 0;
            holdUntil = 0;
        },
    };
})()
