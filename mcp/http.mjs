import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { createCounselServer } from "./server.mjs";
export async function handleMcpRequest(req, res, invoke) {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const server = createCounselServer(null, invoke);
  try {
    await server.connect(transport);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers))
      if (value)
        headers.set(key, Array.isArray(value) ? value.join(",") : value);
    const request = new Request("http://localhost/agent/v1/mcp", {
      method: req.method,
      headers,
    });
    const response = await transport.handleRequest(request, {
      parsedBody: req.body,
    });
    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));
    res.send(Buffer.from(await response.arrayBuffer()));
  } finally {
    await server.close();
  }
}
