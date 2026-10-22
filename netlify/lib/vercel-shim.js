"use strict";

/**
 * Vercel 스타일 `(req, res)` 핸들러를 Netlify Functions v1 이벤트로 감싼다.
 *
 * 기존 api/*.js 를 재작성하지 않고 그대로 이식하기 위한 최소 shim 이다.
 * 지원 범위: req.method, req.headers(소문자), req.query, req.body,
 * res.status(), res.setHeader(), res.json(), res.send(), res.end().
 */

function normalizeHeaders(input) {
    const out = {};
    for (const [key, value] of Object.entries(input || {})) {
        if (value === undefined || value === null) continue;
        const name = String(key).toLowerCase();
        // Cookie 헤더는 브라우저에서 한 줄로 오지만, 프록시가 배열로 넘길 수 있다.
        out[name] = Array.isArray(value)
            ? value.join(name === "cookie" ? "; " : ", ")
            : String(value);
    }
    return out;
}

function parseQuery(rawQuery, queryStringParameters) {
    const query = {};
    if (typeof rawQuery === "string" && rawQuery.length > 0) {
        for (const [key, value] of new URLSearchParams(rawQuery)) {
            if (Object.prototype.hasOwnProperty.call(query, key)) {
                query[key] = Array.isArray(query[key]) ? [...query[key], value] : [query[key], value];
            } else {
                query[key] = value;
            }
        }
        return query;
    }
    for (const [key, value] of Object.entries(queryStringParameters || {})) {
        query[key] = value;
    }
    return query;
}

function parseBody(event, headers) {
    if (event.body === undefined || event.body === null) return undefined;
    let raw = event.body;
    if (event.isBase64Encoded) raw = Buffer.from(String(raw), "base64").toString("utf8");
    if (/^application\/json(?:;|$)/i.test(headers["content-type"] || "")) {
        try {
            return JSON.parse(raw);
        } catch {
            // 잘못된 JSON 은 원문을 넘겨 핸들러가 400 INVALID_INPUT 으로 처리하게 한다.
            return raw;
        }
    }
    return raw;
}

function createHandler(handler) {
    if (typeof handler !== "function") throw new TypeError("handler must be a function");

    return async function netlifyHandler(event) {
        const headers = normalizeHeaders(event.headers);
        const method = String(event.httpMethod || "GET").toUpperCase();
        const path = event.path || "/";
        const rawQuery = typeof event.rawQuery === "string" ? event.rawQuery : "";
        const req = {
            method,
            httpMethod: method,
            url: event.rawUrl || (path + (rawQuery ? "?" + rawQuery : "")),
            path,
            headers,
            query: parseQuery(rawQuery, event.queryStringParameters),
            body: parseBody(event, headers),
            cookies: {},
            socket: {
                remoteAddress: headers["x-nf-client-connection-ip"] || headers["client-ip"] || ""
            }
        };
        for (const part of String(headers.cookie || "").split(";")) {
            const at = part.indexOf("=");
            if (at > 0) req.cookies[part.slice(0, at).trim()] = part.slice(at + 1).trim();
        }

        let statusCode = 200;
        let ended = false;
        const responseHeaders = {};
        const chunks = [];

        const res = {
            get statusCode() { return statusCode; },
            set statusCode(value) { statusCode = Number(value) || 200; },
            get headersSent() { return ended; },
            setHeader(name, value) {
                if (ended) throw new Error("Cannot set headers after they are sent");
                responseHeaders[String(name).toLowerCase()] = value;
                return res;
            },
            getHeader(name) { return responseHeaders[String(name).toLowerCase()]; },
            removeHeader(name) { delete responseHeaders[String(name).toLowerCase()]; },
            status(code) { statusCode = Number(code) || 200; return res; },
            json(value) {
                if (!responseHeaders["content-type"]) {
                    responseHeaders["content-type"] = "application/json; charset=utf-8";
                }
                return res.end(JSON.stringify(value));
            },
            send(value) {
                if (value === undefined || value === null) return res.end("");
                if (Buffer.isBuffer(value)) return res.end(value);
                if (typeof value === "object") return res.json(value);
                return res.end(String(value));
            },
            write(chunk) {
                if (ended) return false;
                if (chunk !== undefined && chunk !== null) {
                    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8"));
                }
                return true;
            },
            end(chunk) {
                if (ended) return res;
                if (chunk !== undefined && chunk !== null) {
                    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8"));
                }
                ended = true;
                return res;
            },
            writeHead(code, headersOrMessage, maybeHeaders) {
                statusCode = Number(code) || statusCode;
                const extra = headersOrMessage && typeof headersOrMessage === "object"
                    ? headersOrMessage
                    : maybeHeaders;
                for (const [name, value] of Object.entries(extra || {})) res.setHeader(name, value);
                return res;
            }
        };

        try {
            const returned = await handler(req, res);
            if (!ended && returned !== undefined) res.send(returned);
            if (!ended) res.end();
        } catch (error) {
            // 토큰·서명·잔고가 로그로 새지 않도록 메시지만 남긴다.
            console.error("[netlify] function failed:", error && error.message ? error.message : "unknown");
            if (!ended) {
                statusCode = 500;
                responseHeaders["content-type"] = "application/json; charset=utf-8";
                res.end(JSON.stringify({ error: "REQUEST_FAILED" }));
            }
        }

        const bodyBuffer = Buffer.concat(chunks);
        const finalHeaders = {};
        const multiValueHeaders = {};
        for (const [name, value] of Object.entries(responseHeaders)) {
            if (Array.isArray(value)) {
                multiValueHeaders[name] = value.map(String);
                // Set-Cookie 는 콤마로 합치면 Expires 의 콤마와 충돌한다. 단일 값만 남긴다.
                finalHeaders[name] = name === "set-cookie" ? String(value[value.length - 1]) : value.join(", ");
            } else {
                finalHeaders[name] = String(value);
            }
        }

        const result = {
            statusCode,
            headers: finalHeaders,
            body: bodyBuffer.toString("utf8"),
            isBase64Encoded: false
        };
        if (Object.keys(multiValueHeaders).length > 0) result.multiValueHeaders = multiValueHeaders;
        return result;
    };
}

module.exports = { createHandler, normalizeHeaders, parseQuery, parseBody };
