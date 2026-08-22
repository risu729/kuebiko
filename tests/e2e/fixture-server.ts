// The page under capture drives one request/response pair, one WebSocket, and one
// Server-Sent Events stream, so a run exercises every record file the logger writes.
const PAGE_HTML = `<!doctype html>
<meta charset="utf-8">
<script>
void fetch("/api/data", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ hello: "from-page" })
});
const socket = new WebSocket("ws://" + location.host + "/socket");
socket.onopen = () => socket.send("hello-from-page");
const events = new EventSource("/events");
</script>`;

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

			if (url.pathname === "/api/data") {
				return Response.json({
					ok: true,
					posted: JSON.parse(await request.text()) as unknown,
					source: "cdp-e2e",
				});
			}

			return new Response(PAGE_HTML, {
				headers: { "content-type": "text/html; charset=utf-8" },
			});
		},
		hostname: "127.0.0.1",
		port: 0,
		websocket: {
			message: (socket, message) => {
				socket.send(`echo:${String(message)}`);
			},
		},
	});

export default startFixtureServer;
