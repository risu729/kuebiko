// The page under capture drives one request/response pair, one WebSocket, one
// Server-Sent Events stream, and one download.
// A run therefore exercises every record file the logger writes.
// A cookie is set first so the request the page makes carries one over the wire.
// Both web storage areas and one IndexedDB object store are filled too.
// Those are what the end-of-run snapshot reads back out of the browser process.
// The IndexedDB write is asynchronous, so the page announces it with a request.
// The test waits for that request before it shuts the logger down.
// The download starts from a link click, which is what a real export button does.
const PAGE_HTML = `<!doctype html>
<meta charset="utf-8">
<script>
document.cookie = "e2e=1; path=/";
localStorage.setItem("e2e-local", "local-value");
sessionStorage.setItem("e2e-session", "session-value");
const opened = indexedDB.open("e2e-db", 1);
opened.onupgradeneeded = () => {
  opened.result.createObjectStore("sessions");
};
opened.onsuccess = () => {
  const transaction = opened.result.transaction("sessions", "readwrite");
  transaction.objectStore("sessions").put({ token: "e2e-token" }, "current");
  transaction.oncomplete = () => {
    void fetch("/api/storage-ready");
  };
};
void fetch("/api/data", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ hello: "from-page" })
});
const socket = new WebSocket("ws://" + location.host + "/socket");
socket.onopen = () => socket.send("hello-from-page");
const events = new EventSource("/events");
addEventListener("load", () => {
  const link = document.createElement("a");
  link.href = "/statement.csv";
  link.download = "statement.csv";
  document.body.append(link);
  link.click();
});
</script>`;

const DOWNLOAD_CSV = "date,amount\n2026-07-06,12.34\n";

// The stream is never closed, so it behaves like a real SSE endpoint:
// Network.loadingFinished never fires and only the message events carry the payloads.
const eventStreamResponse = (): Response =>
	new Response(
		new ReadableStream<Uint8Array>({
			start: (controller) => {
				const encoder = new TextEncoder();
				controller.enqueue(encoder.encode('event: price\nid: 1\ndata: {"price":1}\n\n'));
				controller.enqueue(encoder.encode('event: price\nid: 2\ndata: {"price":2}\n\n'));
			},
		}),
		{
			headers: {
				"cache-control": "no-cache",
				"content-type": "text/event-stream",
			},
		},
	);

// Content-Disposition is what turns the link click into a browser download.
const downloadResponse = (): Response =>
	new Response(DOWNLOAD_CSV, {
		headers: {
			"content-disposition": 'attachment; filename="statement.csv"',
			"content-type": "text/csv",
		},
	});

const startFixtureServer = (): ReturnType<typeof Bun.serve> =>
	Bun.serve({
		fetch: async (request, server) => {
			const url = new URL(request.url);
			if (url.pathname === "/events") {
				return eventStreamResponse();
			}

			if (url.pathname === "/socket") {
				return server.upgrade(request, { data: undefined })
					? undefined
					: new Response("upgrade failed", { status: 400 });
			}

			if (url.pathname === "/statement.csv") {
				return downloadResponse();
			}

			if (url.pathname === "/api/data") {
				return Response.json(
					{
						ok: true,
						posted: JSON.parse(await request.text()) as unknown,
						source: "cdp-e2e",
					},
					// Only the raw headers of --capture-cookies carry this back out.
					{ headers: { "set-cookie": "e2e-response=1; path=/" } },
				);
			}

			return new Response(PAGE_HTML, {
				headers: { "content-type": "text/html; charset=utf-8" },
			});
		},
		hostname: "127.0.0.1",
		// The SSE route holds a response open with no traffic on it.
		// Disabling the default 10s idle timeout keeps that response from being closed.
		// A closed stream would make the page reconnect and replay the events.
		idleTimeout: 0,
		port: 0,
		websocket: {
			message: (socket, message) => {
				socket.send(`echo:${String(message)}`);
			},
		},
	});

export default startFixtureServer;
export { DOWNLOAD_CSV };
