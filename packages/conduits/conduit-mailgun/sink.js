
// sink.ts — Mailgun, standing in for Mailgun.
//
// Basic `api:<key>`, form-encoded sends under `/v3/{domain}/messages`, a 400
// `{ message }` refusal in Mailgun's own wording, and `/v3/{domain}/events`
// listing what was accepted. The inbound half: `POST /_sink/inbound` makes the
// sink write a raw RFC 5322 message the way a sender's mail client does —
// encoded words in the headers, quoted-printable text, base64 parts — and
// forward it to the hook URL as a route whose URL ends in `mime` does: a
// multipart form carrying the envelope, `body-mime`, and a signature over
// `timestamp + token` under the signing key. A second delivery is re-signed
// with a NEW token, which is what Mailgun's retry does.
// Chaos: `{ lost }`, `{ rateLimit }`, `{ failNext }`, `{ deliverTwice }`.
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.hasOwn(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
var _a;
Object.defineProperty(exports, "__esModule", { value: true });
exports.rawMime = rawMime;
exports.startMailgunSink = startMailgunSink;
var node_crypto_1 = require("node:crypto");
var json = function (b, status, headers) {
    if (status === void 0) { status = 200; }
    if (headers === void 0) { headers = {}; }
    return new Response(JSON.stringify(b), { status: status, headers: __assign({ 'content-type': 'application/json' }, headers) });
};
var refuse = function (message, status, headers) {
    if (status === void 0) { status = 400; }
    if (headers === void 0) { headers = {}; }
    return json({ message: message }, status, headers);
};
var n = 0;
var msgId = function (domain) { return "<".concat(Date.now().toString(36), ".").concat((++n).toString(36), "@").concat(domain, ">"); };
/** RFC 2047 B-encoding for a header value that is not ASCII. */
var word = function (s) { return /^[\x20-\x7e]*$/.test(s) ? s : "=?UTF-8?B?".concat(Buffer.from(s, 'utf8').toString('base64'), "?="); };
/** Quoted-printable, line by line; a line break stays a line break. */
function qp(s) {
    return s.split('\n').map(function (line) {
        var out = '';
        for (var _i = 0, _a = Buffer.from(line.replace(/\r$/, ''), 'utf8'); _i < _a.length; _i++) {
            var b = _a[_i];
            out += (b >= 33 && b <= 126 && b !== 61) || b === 32 ? String.fromCharCode(b) : "=".concat(b.toString(16).toUpperCase().padStart(2, '0'));
        }
        return out;
    }).join('\r\n');
}
/** The message as a sender's mail client writes it. */
function rawMime(m, domain) {
    var _a, _b, _c, _d;
    var text = (_a = m.text) !== null && _a !== void 0 ? _a : '';
    var body = /^[\x00-\x7f]*$/.test(text)
        ? ['Content-Type: text/plain; charset=utf-8', '', text]
        : ['Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable', '', qp(text)];
    var parts = ((_b = m.attachments) === null || _b === void 0 ? void 0 : _b.length) ? multipart(body, m.attachments) : body;
    return __spreadArray(__spreadArray(__spreadArray(__spreadArray([
        "From: ".concat(m.fromName ? "".concat(word(m.fromName), " <").concat(m.from, ">") : m.from),
        "To: ".concat(m.to),
        "Subject: ".concat(word((_c = m.subject) !== null && _c !== void 0 ? _c : ''))
    ], (m.messageId === null ? [] : ["Message-ID: ".concat((_d = m.messageId) !== null && _d !== void 0 ? _d : msgId(domain))]), true), (m.inReplyTo ? ["In-Reply-To: ".concat(m.inReplyTo)] : []), true), [
        "Date: ".concat(new Date().toUTCString()),
        'MIME-Version: 1.0'
    ], false), parts, true).join('\r\n');
}
/** multipart/mixed: the text part, then each file in base64, its name RFC 2231-encoded; a `cid` makes it an inline part. */
function multipart(body, files) {
    var b = "b".concat((0, node_crypto_1.randomBytes)(8).toString('hex'));
    return __spreadArray(__spreadArray(__spreadArray([
        "Content-Type: multipart/mixed; boundary=\"".concat(b, "\""),
        '',
        "--".concat(b)
    ], body, true), files.flatMap(function (f) { return __spreadArray(__spreadArray([
        "--".concat(b),
        "Content-Type: ".concat(f.type),
        "Content-Disposition: ".concat(f.cid ? 'inline' : 'attachment', "; filename*=UTF-8''").concat(encodeURIComponent(f.name))
    ], (f.cid ? ["Content-ID: <".concat(f.cid, ">")] : []), true), [
        'Content-Transfer-Encoding: base64',
        '',
        f.base64,
    ], false); }), true), [
        "--".concat(b, "--"),
        '',
    ], false);
}
function startMailgunSink(opts) {
    var _a, _b, _c;
    if (opts === void 0) { opts = {}; }
    var KEY = (_a = opts.key) !== null && _a !== void 0 ? _a : 'key-mailgun-dev';
    var SIGNING = (_b = opts.signingKey) !== null && _b !== void 0 ? _b : 'whsec-mailgun-dev';
    var BASIC = "Basic ".concat(Buffer.from("api:".concat(KEY)).toString('base64'));
    var sent = [];
    var seen = [];
    var events = [];
    var armed = { lost: false, failNext: false, rateLimit: null, deliverTwice: false };
    var hanging = [];
    function forward(spec) {
        return __awaiter(this, void 0, void 0, function () {
            var times, raw, i, timestamp, token, signature, form, fields, _i, _a, _b, k, v, res, _c;
            var _d, _e;
            return __generator(this, function (_f) {
                switch (_f.label) {
                    case 0:
                        times = armed.deliverTwice ? 2 : 1;
                        armed.deliverTwice = false;
                        raw = rawMime(spec, (_d = spec.from.split('@')[1]) !== null && _d !== void 0 ? _d : 'example.org');
                        i = 0;
                        _f.label = 1;
                    case 1:
                        if (!(i < times)) return [3 /*break*/, 6];
                        if (!opts.hookUrl) {
                            events.push({ type: 'Inbound', status: null });
                            return [3 /*break*/, 5];
                        }
                        timestamp = String(Math.floor(Date.now() / 1000)), token = (0, node_crypto_1.randomBytes)(25).toString('hex');
                        signature = (0, node_crypto_1.createHmac)('sha256', SIGNING).update(timestamp + token).digest('hex');
                        form = new FormData();
                        fields = { recipient: spec.to, sender: spec.from, from: spec.fromName ? "".concat(spec.fromName, " <").concat(spec.from, ">") : spec.from, subject: (_e = spec.subject) !== null && _e !== void 0 ? _e : '', timestamp: timestamp, token: token, signature: signature, 'body-mime': raw };
                        for (_i = 0, _a = Object.entries(fields); _i < _a.length; _i++) {
                            _b = _a[_i], k = _b[0], v = _b[1];
                            form.set(k, v);
                        }
                        _f.label = 2;
                    case 2:
                        _f.trys.push([2, 4, , 5]);
                        return [4 /*yield*/, fetch(opts.hookUrl, { method: 'POST', body: form })];
                    case 3:
                        res = _f.sent();
                        events.push({ type: 'Inbound', status: res.status });
                        return [3 /*break*/, 5];
                    case 4:
                        _c = _f.sent();
                        events.push({ type: 'Inbound', status: null });
                        return [3 /*break*/, 5];
                    case 5:
                        i++;
                        return [3 /*break*/, 1];
                    case 6: return [2 /*return*/, raw];
                }
            });
        });
    }
    var server = Bun.serve({
        port: (_c = opts.port) !== null && _c !== void 0 ? _c : 0,
        fetch: function (req) {
            return __awaiter(this, void 0, void 0, function () {
                var url, path, _a, _b, _c, _d, _e, text, entry, record, retryAfter, messages, eventsAt, domain, p, from, to, variables, _i, p_1, _f, k, v, row, domain_1, items;
                var _g;
                var _this = this;
                return __generator(this, function (_h) {
                    switch (_h.label) {
                        case 0:
                            url = new URL(req.url), path = url.pathname;
                            if (path === '/_sink/seen')
                                return [2 /*return*/, json({ requests: seen, sent: sent, events: events })];
                            if (path === '/_sink/reset') {
                                seen.length = 0;
                                events.length = 0;
                                sent.length = 0;
                                Object.assign(armed, { lost: false, failNext: false, rateLimit: null, deliverTwice: false });
                                return [2 /*return*/, json({ ok: true })];
                            }
                            if (!(path === '/_sink/arm')) return [3 /*break*/, 2];
                            _b = (_a = Object).assign;
                            _c = [armed];
                            return [4 /*yield*/, req.json()];
                        case 1:
                            _b.apply(_a, _c.concat([_h.sent()]));
                            return [2 /*return*/, json({ ok: true })];
                        case 2:
                            if (!(path === '/_sink/inbound' && req.method === 'POST')) return [3 /*break*/, 5];
                            _d = json;
                            _g = { ok: true };
                            _e = forward;
                            return [4 /*yield*/, req.json()];
                        case 3: return [4 /*yield*/, _e.apply(void 0, [_h.sent()])];
                        case 4: return [2 /*return*/, _d.apply(void 0, [(_g.raw = _h.sent(), _g)])];
                        case 5: return [4 /*yield*/, req.text()];
                        case 6:
                            text = _h.sent();
                            entry = { path: path, headers: Object.fromEntries(req.headers), body: text, status: 0 };
                            seen.push(entry);
                            record = function (r) { return __awaiter(_this, void 0, void 0, function () { return __generator(this, function (_a) {
                                switch (_a.label) {
                                    case 0:
                                        if (!armed.lost) return [3 /*break*/, 2];
                                        armed.lost = false;
                                        return [4 /*yield*/, new Promise(function (res) { return hanging.push(res); })];
                                    case 1:
                                        _a.sent();
                                        _a.label = 2;
                                    case 2:
                                        entry.status = r.status;
                                        return [2 /*return*/, r];
                                }
                            }); }); };
                            if (req.headers.get('authorization') !== BASIC)
                                return [2 /*return*/, record(new Response('Forbidden', { status: 401 }))];
                            if (armed.rateLimit) {
                                retryAfter = armed.rateLimit.retryAfter;
                                armed.rateLimit = null;
                                return [2 /*return*/, record(refuse('Too many requests', 429, { 'retry-after': String(retryAfter) }))];
                            }
                            if (armed.failNext) {
                                armed.failNext = false;
                                return [2 /*return*/, record(refuse('Internal server error', 500))];
                            }
                            messages = path.match(/^\/v3\/([^/]+)\/messages$/), eventsAt = path.match(/^\/v3\/([^/]+)\/events$/);
                            if (messages && req.method === 'POST') {
                                domain = decodeURIComponent(messages[1]);
                                if (domain === 'nobody.example')
                                    return [2 /*return*/, record(refuse("Domain not found: ".concat(domain), 404))];
                                p = new URLSearchParams(text);
                                from = p.get('from'), to = p.get('to');
                                if (!from)
                                    return [2 /*return*/, record(refuse("'from' parameter is missing"))];
                                if (!to)
                                    return [2 /*return*/, record(refuse("'to' parameter is missing"))];
                                if (!/^[^@\s,]+@[^@\s,]+$/.test(to.split(',')[0].trim().replace(/^.*<|>$/g, '')))
                                    return [2 /*return*/, record(refuse("'to' parameter is not a valid address. please check documentation"))];
                                if (!p.get('text') && !p.get('html'))
                                    return [2 /*return*/, record(refuse("Need at least one of 'text' or 'html' parameters specified"))];
                                variables = {};
                                for (_i = 0, p_1 = p; _i < p_1.length; _i++) {
                                    _f = p_1[_i], k = _f[0], v = _f[1];
                                    if (k.startsWith('v:'))
                                        variables[k.slice(2)] = v;
                                }
                                row = { id: msgId(domain), domain: domain, to: to, tag: p.get('o:tag'), variables: variables };
                                sent.push(row);
                                return [2 /*return*/, record(json({ id: row.id, message: 'Queued. Thank you.' }))];
                            }
                            if (eventsAt && req.method === 'GET') {
                                domain_1 = decodeURIComponent(eventsAt[1]);
                                items = sent
                                    .filter(function (s) { return s.domain === domain_1; })
                                    .filter(function (s) { return __spreadArray([], url.searchParams, true).every(function (_a) {
                                    var k = _a[0], v = _a[1];
                                    return k === 'event' ? v === 'accepted' : k === 'limit' || (k === 'tags' ? s.tag === v : s.variables[k] === v);
                                }); })
                                    .map(function (s) { return ({ id: (0, node_crypto_1.randomBytes)(8).toString('base64url'), event: 'accepted', timestamp: Date.now() / 1000, recipient: s.to, tags: s.tag ? [s.tag] : [], 'user-variables': s.variables, message: { headers: { 'message-id': s.id.replace(/^<|>$/g, '') } } }); });
                                return [2 /*return*/, record(json({ items: items, paging: {} }))];
                            }
                            return [2 /*return*/, record(refuse("No route for ".concat(req.method, " ").concat(path), 404))];
                    }
                });
            });
        },
    });
    return { port: server.port, url: "http://127.0.0.1:".concat(server.port), key: KEY, signingKey: SIGNING, stop: function () { for (var _i = 0, hanging_1 = hanging; _i < hanging_1.length; _i++) {
            var r = hanging_1[_i];
            r();
        } server.stop(true); } };
}
if (import.meta.main)
    console.log("[mailgun-sink] ".concat(startMailgunSink({ port: Number((_a = process.env.MAILGUN_SINK_PORT) !== null && _a !== void 0 ? _a : 0), hookUrl: process.env.MAILGUN_HOOK_URL }).url));
