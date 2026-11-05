
// sink.ts — Postmark, standing in for Postmark.
//
// `X-Postmark-Server-Token`, JSON, PascalCase; a 422 `{ ErrorCode, Message }`
// refusal; a batch answering per-message codes on a 200; and the inbound
// half: `POST /_sink/inbound` makes the sink deliver a parsed message to the
// hook URL with the URL's Basic credential (as Postmark does), and an address
// under `@bounce.example` produces a `Bounce` webhook with `Inactive: true`.
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
var _a;
Object.defineProperty(exports, "__esModule", { value: true });
exports.startPostmarkSink = startPostmarkSink;
var json = function (b, status, headers) {
    if (status === void 0) { status = 200; }
    if (headers === void 0) { headers = {}; }
    return new Response(JSON.stringify(b), { status: status, headers: __assign({ 'content-type': 'application/json' }, headers) });
};
var refuse = function (ErrorCode, Message, status, headers) {
    if (status === void 0) { status = 422; }
    if (headers === void 0) { headers = {}; }
    return json({ ErrorCode: ErrorCode, Message: Message }, status, headers);
};
var n = 0;
var guid = function () { return "".concat((++n).toString(16).padStart(8, '0'), "-0000-4000-8000-000000000000"); };
function startPostmarkSink(opts) {
    var _a, _b;
    if (opts === void 0) { opts = {}; }
    var TOKEN = (_a = opts.token) !== null && _a !== void 0 ? _a : 'pm-server-token-dev';
    var sent = [];
    var seen = [];
    var events = [];
    var armed = { lost: false, failNext: false, rateLimit: null, deliverTwice: false };
    var hanging = [];
    function deliver(url, type, payload) {
        return __awaiter(this, void 0, void 0, function () {
            var times, i, u, auth, res, _a;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        times = armed.deliverTwice ? 2 : 1;
                        armed.deliverTwice = false;
                        i = 0;
                        _b.label = 1;
                    case 1:
                        if (!(i < times)) return [3 /*break*/, 6];
                        if (!url) {
                            events.push({ type: type, status: null });
                            return [3 /*break*/, 5];
                        }
                        u = new URL(url);
                        auth = u.username ? { authorization: "Basic ".concat(Buffer.from("".concat(decodeURIComponent(u.username), ":").concat(decodeURIComponent(u.password))).toString('base64')) } : {};
                        u.username = '';
                        u.password = '';
                        _b.label = 2;
                    case 2:
                        _b.trys.push([2, 4, , 5]);
                        return [4 /*yield*/, fetch(u, { method: 'POST', headers: __assign({ 'content-type': 'application/json' }, auth), body: JSON.stringify(payload) })];
                    case 3:
                        res = _b.sent();
                        events.push({ type: type, status: res.status });
                        return [3 /*break*/, 5];
                    case 4:
                        _a = _b.sent();
                        events.push({ type: type, status: null });
                        return [3 /*break*/, 5];
                    case 5:
                        i++;
                        return [3 /*break*/, 1];
                    case 6: return [2 /*return*/];
                }
            });
        });
    }
    function accept(e) {
        var _a;
        if (!e.From || !e.To || !e.Subject)
            return { ErrorCode: 300, Message: "Zero recipients specified or 'From' address is missing." };
        if (!/^[^@\s,]+@[^@\s,]+$/.test(e.To.split(',')[0].trim().replace(/^.*<|>$/g, '')))
            return { ErrorCode: 300, Message: "Invalid 'To' address: '".concat(e.To, "'.") };
        if (e.To.includes('@inactive.example'))
            return { ErrorCode: 406, Message: 'You tried to send to a recipient that has been marked as inactive.' };
        if (!e.HtmlBody && !e.TextBody)
            return { ErrorCode: 300, Message: 'Provide either email TextBody or HtmlBody or both.' };
        var row = { MessageID: guid(), To: e.To };
        sent.push(row);
        if (e.To.includes('@bounce.example'))
            void deliver((_a = opts.bounceHookUrl) !== null && _a !== void 0 ? _a : opts.hookUrl, 'Bounce', { RecordType: 'Bounce', ID: n, Type: 'HardBounce', TypeCode: 1, Email: e.To, MessageID: row.MessageID, Description: 'The server was unable to deliver your message', Inactive: true });
        return row;
    }
    var server = Bun.serve({
        port: (_b = opts.port) !== null && _b !== void 0 ? _b : 0,
        fetch: function (req) {
            return __awaiter(this, void 0, void 0, function () {
                var url, path, _a, _b, _c, m, text, entry, record, retryAfter, body, r, out;
                var _this = this;
                var _d, _e, _f;
                return __generator(this, function (_g) {
                    switch (_g.label) {
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
                            _b.apply(_a, _c.concat([_g.sent()]));
                            return [2 /*return*/, json({ ok: true })];
                        case 2:
                            if (!(path === '/_sink/inbound' && req.method === 'POST')) return [3 /*break*/, 5];
                            return [4 /*yield*/, req.json()];
                        case 3:
                            m = _g.sent();
                            return [4 /*yield*/, deliver(opts.hookUrl, 'Inbound', { MessageID: guid(), From: m.from, FromName: (_d = m.fromName) !== null && _d !== void 0 ? _d : '', FromFull: { Email: m.from, Name: (_e = m.fromName) !== null && _e !== void 0 ? _e : '' }, To: m.to, OriginalRecipient: m.to, Subject: m.subject, Date: new Date().toUTCString(), TextBody: m.text, MailboxHash: (_f = m.hash) !== null && _f !== void 0 ? _f : '', Headers: m.messageId ? [{ Name: 'Message-ID', Value: m.messageId }] : [], Attachments: [] })];
                        case 4:
                            _g.sent();
                            return [2 /*return*/, json({ ok: true })];
                        case 5: return [4 /*yield*/, req.text()];
                        case 6:
                            text = _g.sent();
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
                            if (req.headers.get('x-postmark-server-token') !== TOKEN)
                                return [2 /*return*/, record(refuse(10, 'No Account or Server API tokens were supplied, or the tokens were invalid.', 401))];
                            if (armed.rateLimit) {
                                retryAfter = armed.rateLimit.retryAfter;
                                armed.rateLimit = null;
                                return [2 /*return*/, record(refuse(429, 'Rate limit exceeded', 429, { 'retry-after': String(retryAfter) }))];
                            }
                            if (armed.failNext) {
                                armed.failNext = false;
                                return [2 /*return*/, record(json({ ErrorCode: 0, Message: 'Internal error' }, 500))];
                            }
                            try {
                                body = JSON.parse(text);
                            }
                            catch (_h) {
                                return [2 /*return*/, record(refuse(300, 'Invalid JSON', 422))];
                            }
                            if (path === '/email' && req.method === 'POST') {
                                r = accept(body);
                                return [2 /*return*/, record('MessageID' in r ? json({ To: body.To, SubmittedAt: new Date().toISOString(), MessageID: r.MessageID, ErrorCode: 0, Message: 'OK' }) : refuse(r.ErrorCode, r.Message))];
                            }
                            if (path === '/email/batch' && req.method === 'POST') {
                                out = body.map(function (e) { var r = accept(e); return 'MessageID' in r ? { To: e.To, SubmittedAt: new Date().toISOString(), MessageID: r.MessageID, ErrorCode: 0, Message: 'OK' } : { To: e.To, ErrorCode: r.ErrorCode, Message: r.Message }; });
                                return [2 /*return*/, record(json(out))];
                            }
                            return [2 /*return*/, record(refuse(0, "No route for ".concat(req.method, " ").concat(path), 404))];
                    }
                });
            });
        },
    });
    return { port: server.port, url: "http://127.0.0.1:".concat(server.port), token: TOKEN, stop: function () { for (var _i = 0, hanging_1 = hanging; _i < hanging_1.length; _i++) {
            var r = hanging_1[_i];
            r();
        } server.stop(true); } };
}
if (import.meta.main)
    console.log("[postmark-sink] ".concat(startPostmarkSink({ port: Number((_a = process.env.POSTMARK_SINK_PORT) !== null && _a !== void 0 ? _a : 0), hookUrl: process.env.POSTMARK_HOOK_URL }).url));
