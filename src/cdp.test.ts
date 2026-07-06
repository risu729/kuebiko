import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { CdpResponseLogger, createCompletedMetadata } from "./cdp";
import type {
  CompletedResponseMetadata,
  ErrorRecord,
  LoggerStorage,
  RequestState,
  RequestBodySource,
  WebSocketFrameRecord,
} from "./types";

class FakeClient extends EventEmitter {
  Network = {
    enable: vi.fn(() => Promise.resolve()),
    getRequestPostData: vi.fn(() =>
      Promise.resolve({
        postData: '{"from":"getRequestPostData"}',
      }),
    ),
    getResponseBody: vi.fn(() =>
      Promise.resolve({
        base64Encoded: false,
        body: '{"ok":true}',
      }),
    ),
  };

  Target = {
    attachToTarget: vi.fn(() => Promise.resolve({ sessionId: "session-1" })),
    getTargets: vi.fn(() => Promise.resolve({ targetInfos: [] })),
    setAutoAttach: vi.fn(() => Promise.resolve()),
    setDiscoverTargets: vi.fn(() => Promise.resolve()),
  };

  close = vi.fn(() => Promise.resolve());

  send = vi.fn(() => Promise.resolve());
}

const createStorage = (): LoggerStorage & {
  errors: ErrorRecord[];
  metadata: CompletedResponseMetadata[];
  websocket: WebSocketFrameRecord[];
} => {
  const metadata: CompletedResponseMetadata[] = [];
  const errors: ErrorRecord[] = [];
  const websocket: WebSocketFrameRecord[] = [];

  return {
    close: vi.fn(() => Promise.resolve()),
    errors,
    metadata,
    recordRequestBody: vi.fn((state, postData) =>
      Promise.resolve(
        (() => {
          const source: RequestBodySource =
            state.requestPostData === postData ? "requestWillBeSent" : "getRequestPostData";

          return {
            bodyFile: "requests/request.json",
            bodyLength: Buffer.byteLength(postData),
            bodySaved: true,
            bodySha256: "request-hash",
            source,
          };
        })(),
      ),
    ),
    recordBody: vi.fn(() =>
      Promise.resolve({
        base64Encoded: false,
        bodyFile: "bodies/body.json",
        bodyLength: 11,
        bodySaved: true,
        bodySha256: "hash",
      }),
    ),
    recordCompletedResponse: vi.fn((record) => {
      metadata.push(record);
      return Promise.resolve();
    }),
    recordError: vi.fn((record) => {
      errors.push(record);
      return Promise.resolve();
    }),
    recordWebSocketFrame: vi.fn((record) => {
      websocket.push(record);
      return Promise.resolve();
    }),
    runDirectory: "/captures/run",
    runTimestamp: "2026-07-06T12:34:56Z",
    websocket,
  };
};

const waitForAsyncEvent = async (): Promise<void> => {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
  }
};

describe("createCompletedMetadata", () => {
  it("creates one appendable metadata object per response", () => {
    const state: RequestState = {
      loaderId: "loader-1",
      requestHeaders: { accept: "application/json" },
      requestId: "request-1",
      requestMethod: "GET",
      requestUrl: "https://example.test/api",
      response: {
        charset: "",
        connectionId: 1,
        connectionReused: false,
        encodedDataLength: 123,
        fromDiskCache: false,
        headers: { "content-type": "application/json" },
        mimeType: "application/json",
        protocol: "h2",
        remoteIPAddress: "203.0.113.10",
        remotePort: 443,
        securityState: "secure",
        status: 200,
        statusText: "OK",
        url: "https://example.test/api",
      },
      session: {
        sessionId: "session-1",
        targetId: "target-1",
        targetType: "page",
        targetUrl: "https://example.test",
      },
    };

    expect(
      createCompletedMetadata(
        state,
        { encodedDataLength: 123, requestId: "request-1", timestamp: 1 },
        {
          base64Encoded: false,
          bodyFile: "bodies/body.json",
          bodyLength: 11,
          bodySaved: true,
          bodySha256: "hash",
        },
        {},
        "2026-07-06T12:34:56Z",
      ),
    ).toMatchObject({
      bodyFile: "bodies/body.json",
      bodySaved: true,
      encodedDataLength: 123,
      mimeType: "application/json",
      requestHeaders: { accept: "application/json" },
      requestId: "request-1",
      requestMethod: "GET",
      responseHeaders: { "content-type": "application/json" },
      runTimestamp: "2026-07-06T12:34:56Z",
      sessionId: "session-1",
      status: 200,
      url: "https://example.test/api",
    });
  });

  it("adds request body metadata when post data was captured", () => {
    const state: RequestState = {
      hasPostData: true,
      loaderId: "loader-1",
      requestContentType: "application/json",
      requestHeaders: { "content-type": "application/json" },
      requestId: "request-1",
      requestMethod: "POST",
      requestPostData: '{"hello":"world"}',
      requestUrl: "https://example.test/api",
      response: {
        charset: "",
        connectionId: 1,
        connectionReused: false,
        encodedDataLength: 123,
        headers: { "content-type": "application/json" },
        mimeType: "application/json",
        securityState: "secure",
        status: 200,
        statusText: "OK",
        url: "https://example.test/api",
      },
      session: {
        sessionId: "session-1",
        targetId: "target-1",
        targetType: "page",
        targetUrl: "https://example.test",
      },
    };

    expect(
      createCompletedMetadata(
        state,
        { encodedDataLength: 123, requestId: "request-1", timestamp: 1 },
        {
          base64Encoded: false,
          bodyFile: "bodies/body.json",
          bodyLength: 11,
          bodySaved: true,
          bodySha256: "hash",
        },
        {
          bodyFile: "requests/request.json",
          bodyLength: 17,
          bodySaved: true,
          bodySha256: "request-hash",
          source: "requestWillBeSent",
        },
        "2026-07-06T12:34:56Z",
      ),
    ).toMatchObject({
      requestBodyFile: "requests/request.json",
      requestBodyLength: 17,
      requestBodySaved: true,
      requestBodySha256: "request-hash",
      requestBodySource: "requestWillBeSent",
      requestMethod: "POST",
    });
  });
});

describe("CdpResponseLogger", () => {
  it("captures completed response bodies and metadata", async () => {
    const client = new FakeClient();
    const storage = createStorage();
    const logger = new CdpResponseLogger(client as never, {
      cdp: "http://127.0.0.1:9222",
      storage,
      verbose: false,
    });

    await logger.start();
    client.emit("Target.attachedToTarget", {
      sessionId: "session-1",
      targetInfo: {
        attached: true,
        browserContextId: "context-1",
        canAccessOpener: false,
        targetId: "target-1",
        title: "Example",
        type: "page",
        url: "https://example.test",
      },
      waitingForDebugger: false,
    });
    await waitForAsyncEvent();
    client.emit(
      "Network.requestWillBeSent",
      {
        documentURL: "https://example.test",
        frameId: "frame-1",
        hasUserGesture: false,
        initiator: { type: "other" },
        loaderId: "loader-1",
        request: {
          headers: { accept: "application/json" },
          initialPriority: "High",
          method: "GET",
          mixedContentType: "none",
          referrerPolicy: "strict-origin-when-cross-origin",
          url: "https://example.test/api",
        },
        requestId: "request-1",
        timestamp: 1,
        type: "XHR",
        wallTime: 1,
      },
      "session-1",
    );
    client.emit(
      "Network.responseReceived",
      {
        frameId: "frame-1",
        hasExtraInfo: false,
        loaderId: "loader-1",
        requestId: "request-1",
        response: {
          headers: { "content-type": "application/json" },
          mimeType: "application/json",
          status: 200,
          statusText: "OK",
          url: "https://example.test/api",
        },
        timestamp: 2,
        type: "XHR",
      },
      "session-1",
    );
    client.emit(
      "Network.loadingFinished",
      { encodedDataLength: 123, requestId: "request-1", timestamp: 3 },
      "session-1",
    );
    await waitForAsyncEvent();

    expect(client.Network.enable).toHaveBeenCalledWith(
      { maxResourceBufferSize: 104_857_600, maxTotalBufferSize: 524_288_000 },
      "session-1",
    );
    expect(client.send).not.toHaveBeenCalledWith(
      "Runtime.runIfWaitingForDebugger",
      expect.anything(),
      expect.anything(),
    );
    expect(storage.recordBody).toHaveBeenCalledOnce();
    expect(storage.metadata).toHaveLength(1);
    expect(storage.metadata[0]).toMatchObject({
      bodyFile: "bodies/body.json",
      bodySaved: true,
      requestBodySaved: undefined,
      requestId: "request-1",
      requestMethod: "GET",
      status: 200,
      url: "https://example.test/api",
    });
  });

  it("resumes auto-attached targets that are waiting for debugger", async () => {
    const client = new FakeClient();
    const storage = createStorage();
    const logger = new CdpResponseLogger(client as never, {
      cdp: "http://127.0.0.1:9222",
      storage,
      verbose: false,
    });

    await logger.start();
    client.emit("Target.attachedToTarget", {
      sessionId: "session-1",
      targetInfo: {
        attached: true,
        browserContextId: "context-1",
        canAccessOpener: true,
        targetId: "target-1",
        title: "Popup",
        type: "page",
        url: "https://example.test/popup",
      },
      waitingForDebugger: true,
    });
    await waitForAsyncEvent();

    expect(client.send).toHaveBeenCalledWith(
      "Runtime.runIfWaitingForDebugger",
      undefined,
      "session-1",
    );
    expect(client.Network.enable).toHaveBeenCalledWith(
      { maxResourceBufferSize: 104_857_600, maxTotalBufferSize: 524_288_000 },
      "session-1",
    );
    expect(client.send.mock.invocationCallOrder[0]).toBeLessThan(
      client.Network.enable.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("records resume failures and still enables network capture", async () => {
    const client = new FakeClient();
    client.send.mockRejectedValueOnce(new Error("resume failed"));
    const storage = createStorage();
    const logger = new CdpResponseLogger(client as never, {
      cdp: "http://127.0.0.1:9222",
      storage,
      verbose: false,
    });

    await logger.start();
    client.emit("Target.attachedToTarget", {
      sessionId: "session-1",
      targetInfo: {
        attached: true,
        browserContextId: "context-1",
        canAccessOpener: true,
        targetId: "target-1",
        title: "Popup",
        type: "page",
        url: "https://example.test/popup",
      },
      waitingForDebugger: true,
    });
    await waitForAsyncEvent();

    expect(storage.errors[0]).toMatchObject({
      error: "resume failed",
      event: "Runtime.runIfWaitingForDebugger",
      sessionId: "session-1",
      targetId: "target-1",
      url: "https://example.test/popup",
    });
    expect(client.Network.enable).toHaveBeenCalledWith(
      { maxResourceBufferSize: 104_857_600, maxTotalBufferSize: 524_288_000 },
      "session-1",
    );
  });

  it("saves inline request post data without request interception", async () => {
    const client = new FakeClient();
    const storage = createStorage();
    const logger = new CdpResponseLogger(client as never, {
      cdp: "http://127.0.0.1:9222",
      storage,
      verbose: false,
    });

    await logger.start();
    client.emit("Target.attachedToTarget", {
      sessionId: "session-1",
      targetInfo: {
        attached: true,
        browserContextId: "context-1",
        canAccessOpener: false,
        targetId: "target-1",
        title: "Example",
        type: "page",
        url: "https://example.test",
      },
      waitingForDebugger: false,
    });
    await waitForAsyncEvent();
    client.emit(
      "Network.requestWillBeSent",
      {
        documentURL: "https://example.test",
        frameId: "frame-1",
        hasUserGesture: false,
        initiator: { type: "other" },
        loaderId: "loader-1",
        request: {
          hasPostData: true,
          headers: { "content-type": "application/json" },
          initialPriority: "High",
          method: "POST",
          mixedContentType: "none",
          postData: '{"hello":"world"}',
          referrerPolicy: "strict-origin-when-cross-origin",
          url: "https://example.test/api",
        },
        requestId: "request-1",
        timestamp: 1,
        type: "XHR",
        wallTime: 1,
      },
      "session-1",
    );
    client.emit(
      "Network.responseReceived",
      {
        frameId: "frame-1",
        hasExtraInfo: false,
        loaderId: "loader-1",
        requestId: "request-1",
        response: {
          headers: { "content-type": "application/json" },
          mimeType: "application/json",
          status: 200,
          statusText: "OK",
          url: "https://example.test/api",
        },
        timestamp: 2,
        type: "XHR",
      },
      "session-1",
    );
    client.emit(
      "Network.loadingFinished",
      { encodedDataLength: 123, requestId: "request-1", timestamp: 3 },
      "session-1",
    );
    await waitForAsyncEvent();

    expect(client.Network.getRequestPostData).not.toHaveBeenCalled();
    expect(storage.recordRequestBody).toHaveBeenCalledWith(
      expect.objectContaining({ requestPostData: '{"hello":"world"}' }),
      '{"hello":"world"}',
    );
    expect(storage.metadata[0]).toMatchObject({
      requestBodyFile: "requests/request.json",
      requestBodyLength: 17,
      requestBodySaved: true,
      requestBodySource: "requestWillBeSent",
      requestMethod: "POST",
    });
  });

  it("falls back to Network.getRequestPostData when post data is not inline", async () => {
    const client = new FakeClient();
    const storage = createStorage();
    const logger = new CdpResponseLogger(client as never, {
      cdp: "http://127.0.0.1:9222",
      storage,
      verbose: false,
    });

    await logger.start();
    client.emit("Target.attachedToTarget", {
      sessionId: "session-1",
      targetInfo: {
        attached: true,
        browserContextId: "context-1",
        canAccessOpener: false,
        targetId: "target-1",
        title: "Example",
        type: "page",
        url: "https://example.test",
      },
      waitingForDebugger: false,
    });
    await waitForAsyncEvent();
    client.emit(
      "Network.requestWillBeSent",
      {
        documentURL: "https://example.test",
        frameId: "frame-1",
        hasUserGesture: false,
        initiator: { type: "other" },
        loaderId: "loader-1",
        request: {
          hasPostData: true,
          headers: { "content-type": "application/json" },
          initialPriority: "High",
          method: "POST",
          mixedContentType: "none",
          referrerPolicy: "strict-origin-when-cross-origin",
          url: "https://example.test/api",
        },
        requestId: "request-1",
        timestamp: 1,
        type: "XHR",
        wallTime: 1,
      },
      "session-1",
    );
    client.emit(
      "Network.responseReceived",
      {
        frameId: "frame-1",
        hasExtraInfo: false,
        loaderId: "loader-1",
        requestId: "request-1",
        response: {
          headers: { "content-type": "application/json" },
          mimeType: "application/json",
          status: 200,
          statusText: "OK",
          url: "https://example.test/api",
        },
        timestamp: 2,
        type: "XHR",
      },
      "session-1",
    );
    client.emit(
      "Network.loadingFinished",
      { encodedDataLength: 123, requestId: "request-1", timestamp: 3 },
      "session-1",
    );
    await waitForAsyncEvent();

    expect(client.Network.getRequestPostData).toHaveBeenCalledWith(
      { requestId: "request-1" },
      "session-1",
    );
    expect(storage.recordRequestBody).toHaveBeenCalledWith(
      expect.objectContaining({ hasPostData: true }),
      '{"from":"getRequestPostData"}',
    );
    expect(storage.metadata[0]).toMatchObject({
      requestBodyFile: "requests/request.json",
      requestBodySource: "getRequestPostData",
    });
  });

  it("labels inline request body save failures with the inline post data source", async () => {
    const client = new FakeClient();
    const storage = createStorage();
    vi.mocked(storage.recordRequestBody).mockResolvedValueOnce({
      bodySaved: false,
      error: "disk full",
      source: "requestWillBeSent",
    });
    const logger = new CdpResponseLogger(client as never, {
      cdp: "http://127.0.0.1:9222",
      storage,
      verbose: false,
    });

    await logger.start();
    client.emit("Target.attachedToTarget", {
      sessionId: "session-1",
      targetInfo: {
        attached: true,
        browserContextId: "context-1",
        canAccessOpener: false,
        targetId: "target-1",
        title: "Example",
        type: "page",
        url: "https://example.test",
      },
      waitingForDebugger: false,
    });
    await waitForAsyncEvent();
    client.emit(
      "Network.requestWillBeSent",
      {
        documentURL: "https://example.test",
        frameId: "frame-1",
        hasUserGesture: false,
        initiator: { type: "other" },
        loaderId: "loader-1",
        request: {
          hasPostData: true,
          headers: { "content-type": "application/json" },
          initialPriority: "High",
          method: "POST",
          mixedContentType: "none",
          postData: '{"hello":"world"}',
          referrerPolicy: "strict-origin-when-cross-origin",
          url: "https://example.test/api",
        },
        requestId: "request-1",
        timestamp: 1,
        type: "XHR",
        wallTime: 1,
      },
      "session-1",
    );
    client.emit(
      "Network.responseReceived",
      {
        frameId: "frame-1",
        hasExtraInfo: false,
        loaderId: "loader-1",
        requestId: "request-1",
        response: {
          headers: { "content-type": "application/json" },
          mimeType: "application/json",
          status: 200,
          statusText: "OK",
          url: "https://example.test/api",
        },
        timestamp: 2,
        type: "XHR",
      },
      "session-1",
    );
    client.emit(
      "Network.loadingFinished",
      { encodedDataLength: 123, requestId: "request-1", timestamp: 3 },
      "session-1",
    );
    await waitForAsyncEvent();

    expect(storage.errors[0]).toMatchObject({
      error: "disk full",
      event: "Network.requestWillBeSent.postData",
      requestId: "request-1",
    });
    expect(storage.metadata[0]).toMatchObject({
      requestBodyError: "disk full",
      requestBodySaved: false,
      requestBodySource: "requestWillBeSent",
    });
  });

  it("records missing getRequestPostData postData as a request body error", async () => {
    const client = new FakeClient();
    client.Network.getRequestPostData.mockResolvedValueOnce({} as never);
    const storage = createStorage();
    const logger = new CdpResponseLogger(client as never, {
      cdp: "http://127.0.0.1:9222",
      storage,
      verbose: false,
    });

    await logger.start();
    client.emit("Target.attachedToTarget", {
      sessionId: "session-1",
      targetInfo: {
        attached: true,
        browserContextId: "context-1",
        canAccessOpener: false,
        targetId: "target-1",
        title: "Example",
        type: "page",
        url: "https://example.test",
      },
      waitingForDebugger: false,
    });
    await waitForAsyncEvent();
    client.emit(
      "Network.requestWillBeSent",
      {
        documentURL: "https://example.test",
        frameId: "frame-1",
        hasUserGesture: false,
        initiator: { type: "other" },
        loaderId: "loader-1",
        request: {
          hasPostData: true,
          headers: { "content-type": "application/json" },
          initialPriority: "High",
          method: "POST",
          mixedContentType: "none",
          referrerPolicy: "strict-origin-when-cross-origin",
          url: "https://example.test/api",
        },
        requestId: "request-1",
        timestamp: 1,
        type: "XHR",
        wallTime: 1,
      },
      "session-1",
    );
    client.emit(
      "Network.responseReceived",
      {
        frameId: "frame-1",
        hasExtraInfo: false,
        loaderId: "loader-1",
        requestId: "request-1",
        response: {
          headers: { "content-type": "application/json" },
          mimeType: "application/json",
          status: 200,
          statusText: "OK",
          url: "https://example.test/api",
        },
        timestamp: 2,
        type: "XHR",
      },
      "session-1",
    );
    client.emit(
      "Network.loadingFinished",
      { encodedDataLength: 123, requestId: "request-1", timestamp: 3 },
      "session-1",
    );
    await waitForAsyncEvent();

    expect(storage.recordRequestBody).not.toHaveBeenCalled();
    expect(storage.errors[0]).toMatchObject({
      error: "Network.getRequestPostData returned no postData.",
      event: "Network.getRequestPostData",
      requestId: "request-1",
    });
    expect(storage.metadata[0]).toMatchObject({
      requestBodyError: "Network.getRequestPostData returned no postData.",
      requestBodySaved: false,
      requestBodySource: "getRequestPostData",
    });
  });

  it("records body retrieval failures without crashing", async () => {
    const client = new FakeClient();
    client.Network.getResponseBody.mockRejectedValueOnce(new Error("No resource with given id"));
    const storage = createStorage();
    const logger = new CdpResponseLogger(client as never, {
      cdp: "http://127.0.0.1:9222",
      storage,
      verbose: false,
    });

    await logger.start();
    client.emit("Target.attachedToTarget", {
      sessionId: "session-1",
      targetInfo: {
        attached: true,
        browserContextId: "context-1",
        canAccessOpener: false,
        targetId: "target-1",
        title: "Example",
        type: "page",
        url: "https://example.test",
      },
      waitingForDebugger: false,
    });
    await waitForAsyncEvent();
    client.emit(
      "Network.responseReceived",
      {
        frameId: "frame-1",
        hasExtraInfo: false,
        loaderId: "loader-1",
        requestId: "request-1",
        response: {
          headers: {},
          mimeType: "application/json",
          status: 200,
          statusText: "OK",
          url: "https://example.test/api",
        },
        timestamp: 2,
        type: "XHR",
      },
      "session-1",
    );
    client.emit(
      "Network.loadingFinished",
      { encodedDataLength: 123, requestId: "request-1", timestamp: 3 },
      "session-1",
    );
    await waitForAsyncEvent();

    expect(storage.metadata[0]).toMatchObject({
      bodySaved: false,
      error: "No resource with given id",
      requestId: "request-1",
    });
    expect(storage.errors[0]).toMatchObject({
      error: "No resource with given id",
      event: "Network.getResponseBody",
      requestId: "request-1",
    });
  });
});
