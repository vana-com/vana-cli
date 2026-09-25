// The page where the owner approves an MCP client (Claude on claude.ai, any
// remote MCP app) that asked the Personal Server for access over OAuth.
//
// The server's /mcp/oauth/authorize redirects the owner's browser here with
// ?mcp_authorization=<id>. This page shows who is asking, lets the owner pick
// which data it may read, and approves through the server's owner-only API
// with the owner token only this process holds. Loopback only: the approval
// happens on the machine that runs the server.

import crypto from "node:crypto";
import http from "node:http";

const APPROVAL_PATH = "/mcp";

const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        ch
      ],
  );

/** "Claude" for claude.ai, else the redirect's host: who is asking. */
export function requesterName(redirectUri) {
  let host = "";
  try {
    host = new URL(redirectUri).host;
  } catch {
    return "An app";
  }
  if (/(^|\.)claude\.(ai|com)$/.test(host)) return "Claude";
  if (/(^|\.)chatgpt\.com$|(^|\.)openai\.com$/.test(host)) return "ChatGPT";
  return host || "An app";
}

// The Vana logotype, as the server's own 1.25 approval pages draw it.
const LOGO = `<svg aria-label="Vana" role="img" viewBox="0 0 718 200" height="13" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M344.76 99.9947C344.76 129.81 344.76 159.639 344.76 189.454C344.76 191.122 344.786 192.804 344.548 194.446C344.004 198.236 342.161 199.864 338.343 199.891C330.162 199.944 321.982 199.918 313.788 199.918C291.965 199.918 270.141 199.958 248.318 199.904C220.541 199.824 195.417 179.511 189.662 152.152C185.287 131.318 189.967 112.527 204.207 96.6715C211.446 88.6104 221.045 84.0193 231.453 81.31C243.306 78.2137 255.424 78.6008 267.503 78.6408C274.265 78.6675 281.026 78.6408 287.788 78.6408C294.987 78.6408 300.662 75.8782 304.255 69.3786C307.888 62.7989 307.371 56.2726 303.672 49.9999C301.312 45.9961 297.546 43.7139 293.012 42.9798C290.214 42.5261 287.351 42.3526 284.513 42.3392C264.228 42.2858 243.956 42.3259 223.67 42.3125C216.047 42.3125 213.727 39.9502 213.713 32.2362C213.7 24.3619 213.673 16.4877 213.726 8.61342C213.78 2.32737 215.848 0.325439 222.106 0.325439C259.945 0.325439 297.772 0.325439 335.611 0.325439C343.222 0.325439 344.773 1.83356 344.773 9.45423C344.786 39.6299 344.773 69.8056 344.773 99.9947H344.76ZM268.709 157.944C275.471 157.944 282.22 157.957 288.981 157.944C299.363 157.904 306.642 150.603 306.748 140.153C306.867 129.209 299.734 121.696 289.034 121.642C275.643 121.575 262.239 121.575 248.848 121.642C238.732 121.682 232.196 127.328 231.201 137.431C230.114 148.588 236.147 157.971 248.782 157.957C255.424 157.957 262.054 157.957 268.696 157.957L268.709 157.944Z"/><path d="M717.957 100.395C717.957 130.571 717.957 160.76 717.957 190.936C717.957 198.743 716.791 199.931 709.207 199.931C680.264 199.931 651.321 199.717 622.391 199.998C595.489 200.251 568.058 180.325 562.741 149.936C559.32 130.411 563.616 112.38 577.113 97.3522C586.42 86.9955 598.539 81.8706 612.076 79.922C628.476 77.5598 644.996 78.9878 661.45 78.6809C675.332 78.4273 683.87 65.5749 678.5 52.6558C676.286 47.3307 672.136 44.181 666.568 42.9531C664.009 42.3792 661.397 42.3125 658.785 42.3125C638.38 42.3259 617.989 42.3259 597.584 42.3125C589.364 42.3125 587.362 40.2572 587.349 31.9025C587.349 24.0283 587.322 16.154 587.349 8.27976C587.375 2.14052 589.178 0.325439 595.145 0.325439C633.461 0.325439 671.765 0.325439 710.082 0.325439C716.473 0.325439 717.957 1.83356 717.957 8.41322C717.957 39.0694 717.957 69.7256 717.957 100.382V100.395ZM642.398 121.616C636.113 121.616 629.815 121.963 623.571 121.522C612.699 120.748 603.709 128.943 604.611 141.181C605.314 150.777 611.916 157.85 621.436 157.904C635.291 157.984 649.159 157.984 663.014 157.904C673.33 157.85 679.866 150.79 679.879 139.913C679.879 128.702 673.555 121.776 663.014 121.616C656.147 121.522 649.279 121.602 642.398 121.602V121.616Z"/><path d="M379.576 99.9952C379.576 70.1798 379.576 40.3645 379.576 10.5491C379.576 8.88082 379.576 7.1992 379.828 5.55762C380.358 2.15435 382.294 0.312575 385.887 0.325921C413.04 0.365959 440.247 -0.608312 467.347 0.632883C500.546 2.15435 527.5 23.4282 535.124 57.2741C536.94 65.3352 537.763 73.4496 537.749 81.7109C537.683 117.852 537.723 153.98 537.709 190.122C537.709 191.67 537.802 193.258 537.511 194.753C536.901 197.903 535.071 199.891 531.664 199.891C521.349 199.905 511.033 199.905 500.718 199.891C497.656 199.891 495.813 198.196 495.269 195.274C494.924 193.418 494.885 191.483 494.885 189.588C494.858 152.98 494.898 116.358 494.858 79.749C494.832 62.1187 484.742 47.7849 468.527 43.7143C454.526 40.2043 438.231 43.1805 428.844 56.1263C424.588 61.9986 422.52 68.6183 422.507 75.8519C422.48 113.902 422.494 151.939 422.48 189.988C422.48 191.417 422.547 192.858 422.374 194.273C421.937 197.836 419.776 199.865 416.222 199.891C406.027 199.945 395.831 199.905 385.622 199.918C382.387 199.918 380.491 198.223 379.934 195.14C379.616 193.405 379.589 191.59 379.589 189.802C379.576 159.866 379.576 129.931 379.576 99.9952Z"/><path d="M89.4414 199.918C73.0805 199.918 56.7064 199.918 40.3454 199.918C34.4719 199.918 33.0798 198.891 32.0059 192.978C29.7785 180.673 27.7632 168.341 25.6153 156.023C22.4863 138.072 19.3043 120.135 16.2018 102.184C13.6032 87.1697 11.0973 72.1419 8.51192 57.1141C5.83371 41.7526 3.11573 26.3912 0.450787 11.0297C0.17236 9.38813 0 7.70652 0 6.05159C0.0265169 2.63497 1.78989 0.472886 5.13102 0.432848C15.9234 0.28604 26.7158 0.339424 37.5081 0.406155C41.1012 0.432848 42.2944 3.20885 42.9308 6.07828C44.0313 11.0698 44.9329 16.1146 45.8212 21.1595C48.0751 33.9451 50.276 46.7307 52.5034 59.5164C56.0699 79.9227 59.61 100.329 63.2163 120.735C64.2902 126.834 65.4304 132.92 66.69 138.98C68.9837 150.03 78.0127 157.557 89.163 157.864C99.8493 158.158 109.674 150.978 112.458 140.408C115.136 130.264 116.343 119.828 118.212 109.511C121.487 91.347 124.669 73.1695 127.851 54.992C130.384 40.4447 132.85 25.8974 135.342 11.35C135.448 10.7628 135.488 10.1622 135.594 9.57498C137.026 1.22027 138.087 0.312732 146.4 0.312732C155.057 0.312732 163.715 0.28604 172.373 0.326078C177.769 0.352771 179.983 2.54154 179.175 7.79994C177.159 20.8525 174.879 33.8784 172.651 46.9042C169.575 64.8549 166.46 82.8055 163.344 100.756C160.719 115.891 158.041 131.025 155.415 146.16C152.804 161.174 150.218 176.189 147.619 191.203C147.474 192.031 147.341 192.845 147.169 193.659C146.121 198.517 144.53 199.878 139.625 199.878C122.906 199.905 106.187 199.878 89.4547 199.878L89.4414 199.918Z"/></svg>`;

// The Vana Account look (same tokens as the server's own approval pages).
const STYLE = `
:root{color-scheme:light dark;--canvas:#f5f5f5;--panel:#fff;--text:#1a1918;--dim:#736c64;--accent:#4141fc;--error:#e7000b;--line:#c2c2c2}
@media (prefers-color-scheme:dark){:root{--canvas:#121212;--panel:#1b1c1d;--text:#d1d1d1;--dim:#a4a4a4;--accent:#559bec;--error:#f75e54;--line:#3d3d3d}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--canvas);color:var(--text);font:15px/1.5 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:16px}
main{width:100%;max-width:480px;background:var(--panel);border-radius:14px;outline:1px solid color-mix(in srgb,var(--line) 20%,transparent);padding:32px}
.logo{color:var(--accent);margin-bottom:12px}h1{font-size:30px;font-weight:500;line-height:1.05;letter-spacing:-.01em;margin:0 0 12px}h1 .kicker{color:var(--accent);display:block}
p{color:var(--dim);margin:0 0 16px}ul{list-style:none;padding:0;margin:0 0 20px;max-height:280px;overflow:auto}li{padding:6px 0}label{display:flex;gap:10px;align-items:center;font-family:"IBM Plex Mono",ui-monospace,Menlo,monospace;font-size:14px}
button{width:100%;min-height:44px;border:0;border-radius:999px;font:inherit;cursor:pointer;margin-top:8px}.primary{background:var(--text);color:var(--panel)}.secondary{background:transparent;color:var(--dim);outline:1px solid color-mix(in srgb,var(--line) 60%,transparent)}
.error{color:var(--error)}code{font-family:"IBM Plex Mono",ui-monospace,Menlo,monospace;font-size:13px}
@media (max-width:480px){main{padding:20px}h1{font-size:27px}}`;

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><main><div class="logo">${LOGO}</div>${body}</main></body></html>`;
}

function messagePage(heading, text, isError = false) {
  return page(
    heading,
    `<h1><span class="kicker">Personal Server</span>${escapeHtml(heading)}</h1><p${isError ? ' class="error"' : ""}>${escapeHtml(text)}</p>`,
  );
}

/**
 * Serve the approval page on 127.0.0.1 and return its URL, which the server
 * uses as its MCP OAuth approval URL.
 *
 * @param {{ serverOrigin: () => string, accessToken: string }} input
 */
export async function startMcpApprovalPage(input) {
  const pending = new Map(); // authorization id -> one-time form token

  const ownerFetch = (path, init = {}) =>
    fetch(`${input.serverOrigin()}${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        authorization: `Bearer ${input.accessToken}`,
        "content-type": "application/json",
      },
      signal: AbortSignal.timeout(30_000),
    });

  async function listScopes() {
    const scopes = [];
    for (let offset = 0; offset < 10_000; offset += 100) {
      const response = await ownerFetch(`/v1/data?limit=100&offset=${offset}`);
      if (!response.ok) break;
      const body = await response.json();
      const batch = Array.isArray(body.scopes) ? body.scopes : [];
      for (const item of batch) {
        const scope = typeof item === "string" ? item : item?.scope;
        if (typeof scope === "string" && !scopes.includes(scope))
          scopes.push(scope);
      }
      const total = typeof body.total === "number" ? body.total : null;
      if (batch.length === 0 || total === null || scopes.length >= total) break;
    }
    return scopes.sort();
  }

  let listenerPort = 0;
  const allowedHosts = () => [
    `127.0.0.1:${listenerPort}`,
    `localhost:${listenerPort}`,
  ];

  const server = http.createServer(async (req, res) => {
    const send = (status, html, headers = {}) => {
      res.writeHead(status, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-frame-options": "DENY",
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self' https: http:; frame-ancestors 'none'",
        ...headers,
      });
      res.end(html);
    };
    try {
      // A page elsewhere must not drive this through a rebound DNS name.
      if (!allowedHosts().includes(req.headers.host ?? "")) {
        return send(
          400,
          messagePage(
            "Wrong address",
            "Open this page from the link your app gave you.",
            true,
          ),
        );
      }
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      if (url.pathname !== APPROVAL_PATH)
        return send(404, messagePage("Not found", "Nothing here.", true));

      if (req.method === "GET") {
        const id = url.searchParams.get("mcp_authorization") ?? "";
        const response = await ownerFetch(
          `/v1/mcp/oauth/authorizations/${encodeURIComponent(id)}`,
        );
        if (!response.ok) {
          return send(
            404,
            messagePage(
              "Request not found",
              "This request expired or was already answered. Start the connection again from your app.",
              true,
            ),
          );
        }
        const authorization = await response.json();
        if (authorization.status !== "pending") {
          return send(
            409,
            messagePage(
              "Already answered",
              "This request was already approved or has expired. Start the connection again from your app if you need to.",
            ),
          );
        }
        const who = requesterName(authorization.redirectUri);
        const scopes = await listScopes();
        const token = crypto.randomBytes(24).toString("base64url");
        pending.set(id, token);
        const list = scopes.length
          ? `<ul>${scopes
              .map(
                (scope) =>
                  `<li><label><input type="checkbox" name="scope" value="${escapeHtml(scope)}" checked> ${escapeHtml(scope)}</label></li>`,
              )
              .join("")}</ul>`
          : `<p class="error">Your Personal Server holds no data yet. Collect some with <code>vana connect &lt;source&gt;</code> first.</p>`;
        return send(
          200,
          page(
            `Allow ${who}`,
            `<h1><span class="kicker">Personal Server</span>Allow ${escapeHtml(who)} to read your data</h1>
<p>${escapeHtml(who)} (${escapeHtml(new URL(authorization.redirectUri).host)}) asks to read data from your Personal Server. It can read only what you tick, and you can revoke it any time.</p>
<form method="post" action="${APPROVAL_PATH}">
<input type="hidden" name="id" value="${escapeHtml(id)}"><input type="hidden" name="token" value="${escapeHtml(token)}">
${list}
<button class="primary" name="action" value="approve"${scopes.length ? "" : " disabled"}>Approve</button>
<button class="secondary" name="action" value="deny">Deny</button>
</form>`,
          ),
        );
      }

      if (req.method === "POST") {
        const origin = req.headers.origin;
        if (
          origin &&
          !allowedHosts()
            .map((h) => `http://${h}`)
            .includes(origin)
        ) {
          return send(
            403,
            messagePage(
              "Not allowed",
              "This form can only be sent from its own page.",
              true,
            ),
          );
        }
        let raw = "";
        for await (const chunk of req) {
          raw += chunk;
          if (raw.length > 100_000)
            return send(
              413,
              messagePage("Too large", "Request too large.", true),
            );
        }
        const form = new URLSearchParams(raw);
        const id = form.get("id") ?? "";
        const token = form.get("token") ?? "";
        const expected = pending.get(id);
        if (
          !expected ||
          token.length !== expected.length ||
          !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))
        ) {
          return send(
            403,
            messagePage(
              "Request expired",
              "Reload the page from your app and try again.",
              true,
            ),
          );
        }
        pending.delete(id);

        const details = await ownerFetch(
          `/v1/mcp/oauth/authorizations/${encodeURIComponent(id)}`,
        );
        const authorization = details.ok ? await details.json() : null;
        if (form.get("action") === "deny") {
          if (!authorization?.redirectUri)
            return send(
              200,
              messagePage(
                "Denied",
                "Nothing was shared. You can close this tab.",
              ),
            );
          const back = new URL(authorization.redirectUri);
          back.searchParams.set("error", "access_denied");
          back.searchParams.set("error_description", "The owner denied access");
          if (authorization.state)
            back.searchParams.set("state", authorization.state);
          res.writeHead(303, {
            location: back.toString(),
            "cache-control": "no-store",
          });
          return res.end();
        }

        const scopes = form.getAll("scope").filter(Boolean);
        if (scopes.length === 0) {
          return send(
            400,
            messagePage(
              "Nothing selected",
              "Tick at least one kind of data, or deny. Go back and try again.",
              true,
            ),
          );
        }
        const approved = await ownerFetch(
          `/v1/mcp/oauth/authorizations/${encodeURIComponent(id)}/approve`,
          {
            method: "POST",
            body: JSON.stringify({ scopes }),
          },
        );
        const body = await approved.json().catch(() => ({}));
        if (!approved.ok || typeof body.redirectTo !== "string") {
          const reason =
            body?.error?.message ?? body?.message ?? `HTTP ${approved.status}`;
          return send(
            502,
            messagePage(
              "Approval failed",
              `Your Personal Server could not approve this: ${reason}`,
              true,
            ),
          );
        }
        res.writeHead(303, {
          location: body.redirectTo,
          "cache-control": "no-store",
        });
        return res.end();
      }

      return send(405, messagePage("Not allowed", "Method not allowed.", true));
    } catch (error) {
      return send(
        500,
        messagePage(
          "Something went wrong",
          error instanceof Error ? error.message : String(error),
          true,
        ),
      );
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  listenerPort = server.address().port;
  return {
    url: `http://127.0.0.1:${listenerPort}${APPROVAL_PATH}`,
    close: () => server.close(),
  };
}
